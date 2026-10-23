/**
 * The source of `caffeine-sensors`, the one compiled piece of Caffeine. The server writes it
 * out and builds it with clang on first use (server/sensors.server.ts), because a plugin
 * cannot learn its own install directory: the binary goes to a fixed path under
 * ~/.jobby-jobs/bin, named by a hash of this text, so a changed source builds anew.
 *
 * It only reads. Temperatures come from the IOHID event system (the services on usage page
 * 0xff00, usage 5: "PMU tdie…", "NAND CH0 temp", …), whose calls are not in the public
 * headers and are looked up at run time; fans come from the SMC through the AppleSMC user
 * client (FNum, F<n>Ac/Mn/Mx, F<n>md). Neither needs root. Printed as one JSON line; with
 * `--fans-pct`, the busiest fan's share of its maximum for the sh guard ("none" without fans,
 * "unknown" without an SMC).
 *
 * Written from the APIs' shapes as exelban/stats and vladkens/macmon (both MIT) use them; no
 * GPL code is copied.
 */
export const SENSORS_SOURCE = String.raw`/* caffeine-sensors: Caffeine's read-only sensor probe. See server/sensors-source.ts. */
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef void *HIDClient;
typedef void *HIDService;
typedef void *HIDEvent;
typedef HIDClient (*ClientCreate)(CFAllocatorRef);
typedef int (*ClientSetMatching)(HIDClient, CFDictionaryRef);
typedef CFArrayRef (*ClientCopyServices)(HIDClient);
typedef CFTypeRef (*ServiceCopyProperty)(HIDService, CFStringRef);
typedef HIDEvent (*ServiceCopyEvent)(HIDService, int64_t, int32_t, int64_t);
typedef double (*EventGetFloat)(HIDEvent, int32_t);

#define TEMPERATURE_EVENT 15

static void json_string(const char *text) {
  putchar('"');
  for (; *text; text++) {
    unsigned char c = (unsigned char)*text;
    if (c == '"' || c == '\\') {
      putchar('\\');
      putchar(c);
    } else if (c < 0x20) {
      printf("\\u%04x", c);
    } else {
      putchar(c);
    }
  }
  putchar('"');
}

static void print_hid(void) {
  void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
  ClientCreate create = iokit ? (ClientCreate)dlsym(iokit, "IOHIDEventSystemClientCreate") : NULL;
  ClientSetMatching setMatching = iokit ? (ClientSetMatching)dlsym(iokit, "IOHIDEventSystemClientSetMatching") : NULL;
  ClientCopyServices copyServices = iokit ? (ClientCopyServices)dlsym(iokit, "IOHIDEventSystemClientCopyServices") : NULL;
  ServiceCopyProperty copyProperty = iokit ? (ServiceCopyProperty)dlsym(iokit, "IOHIDServiceClientCopyProperty") : NULL;
  ServiceCopyEvent copyEvent = iokit ? (ServiceCopyEvent)dlsym(iokit, "IOHIDServiceClientCopyEvent") : NULL;
  EventGetFloat getFloat = iokit ? (EventGetFloat)dlsym(iokit, "IOHIDEventGetFloatValue") : NULL;
  if (!create || !setMatching || !copyServices || !copyProperty || !copyEvent || !getFloat) {
    printf("[]");
    return;
  }
  HIDClient client = create(kCFAllocatorDefault);
  if (!client) {
    printf("[]");
    return;
  }
  int page = 0xff00, usage = 5;
  CFNumberRef pageNumber = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usageNumber = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);
  const void *keys[] = {CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage")};
  const void *values[] = {pageNumber, usageNumber};
  CFDictionaryRef match = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  setMatching(client, match);
  CFArrayRef services = copyServices(client);
  CFIndex count = services ? CFArrayGetCount(services) : 0;
  int first = 1;
  printf("[");
  for (CFIndex i = 0; i < count; i++) {
    HIDService service = (HIDService)CFArrayGetValueAtIndex(services, i);
    char name[128] = "";
    CFTypeRef product = copyProperty(service, CFSTR("Product"));
    if (product) {
      if (CFGetTypeID(product) == CFStringGetTypeID()) CFStringGetCString((CFStringRef)product, name, sizeof name, kCFStringEncodingUTF8);
      CFRelease(product);
    }
    HIDEvent event = copyEvent(service, TEMPERATURE_EVENT, 0, 0);
    if (!event) continue;
    double value = getFloat(event, TEMPERATURE_EVENT << 16);
    CFRelease((CFTypeRef)event);
    if (!first) putchar(',');
    first = 0;
    printf("{\"name\":");
    json_string(name);
    printf(",\"value\":%.2f}", value);
  }
  printf("]");
  if (services) CFRelease(services);
  CFRelease(match);
  CFRelease(pageNumber);
  CFRelease(usageNumber);
  CFRelease((CFTypeRef)client);
}

typedef struct {
  unsigned char major, minor, build, reserved;
  unsigned short release;
} SMCVersion;

typedef struct {
  unsigned short version, length;
  unsigned int cpuPLimit, gpuPLimit, memPLimit;
} SMCLimits;

typedef struct {
  unsigned int dataSize, dataType;
  unsigned char dataAttributes;
} SMCKeyInfo;

typedef struct {
  unsigned int key;
  SMCVersion version;
  SMCLimits limits;
  SMCKeyInfo info;
  unsigned char result, status, data8;
  unsigned int data32;
  unsigned char bytes[32];
} SMCParam;

_Static_assert(sizeof(SMCParam) == 80, "the SMC parameter block is 80 bytes");

static unsigned int fourcc(const char *code) {
  return ((unsigned int)(unsigned char)code[0] << 24) | ((unsigned int)(unsigned char)code[1] << 16) |
         ((unsigned int)(unsigned char)code[2] << 8) | (unsigned int)(unsigned char)code[3];
}

static io_connect_t smc_open(void) {
  const char *names[] = {"AppleSMC", "AppleSMCKeysEndpoint"};
  for (int i = 0; i < 2; i++) {
    io_service_t service = IOServiceGetMatchingService(MACH_PORT_NULL, IOServiceMatching(names[i]));
    if (!service) continue;
    io_connect_t connection = 0;
    kern_return_t opened = IOServiceOpen(service, mach_task_self(), 0, &connection);
    IOObjectRelease(service);
    if (opened == KERN_SUCCESS) return connection;
  }
  return 0;
}

static int smc_call(io_connect_t connection, SMCParam *input, SMCParam *output) {
  size_t size = sizeof(SMCParam);
  return IOConnectCallStructMethod(connection, 2, input, sizeof(SMCParam), output, &size) == KERN_SUCCESS && output->result == 0;
}

/* Reads a numeric key; 1 on success. */
static int smc_number(io_connect_t connection, const char *key, double *value) {
  SMCParam input, output;
  memset(&input, 0, sizeof input);
  memset(&output, 0, sizeof output);
  input.key = fourcc(key);
  input.data8 = 9; /* read key info */
  if (!smc_call(connection, &input, &output)) return 0;
  unsigned int size = output.info.dataSize, type = output.info.dataType;
  if (size == 0 || size > 32) return 0;
  input.info.dataSize = size;
  input.data8 = 5; /* read bytes */
  memset(&output, 0, sizeof output);
  if (!smc_call(connection, &input, &output)) return 0;
  const unsigned char *b = output.bytes;
  if (type == fourcc("flt ") && size == 4) {
    float f;
    memcpy(&f, b, 4);
    *value = f;
  } else if (type == fourcc("fpe2") && size == 2) {
    *value = ((b[0] << 8) | b[1]) / 4.0;
  } else if (type == fourcc("ui8 ") && size == 1) {
    *value = b[0];
  } else if (type == fourcc("ui16") && size == 2) {
    *value = (b[0] << 8) | b[1];
  } else if (type == fourcc("ui32") && size == 4) {
    *value = ((unsigned int)b[0] << 24) | ((unsigned int)b[1] << 16) | ((unsigned int)b[2] << 8) | b[3];
  } else {
    return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  int fansPct = argc > 1 && strcmp(argv[1], "--fans-pct") == 0;
  io_connect_t smc = smc_open();
  double count = -1;
  if (smc && !smc_number(smc, "FNum", &count)) count = -1;
  if (fansPct) {
    if (count < 0) {
      printf("unknown\n");
    } else if (count == 0) {
      printf("none\n");
    } else {
      double top = -1;
      for (int i = 0; i < (int)count && i < 8; i++) {
        char key[5];
        double actual = 0, maximum = 0;
        snprintf(key, sizeof key, "F%dAc", i);
        if (!smc_number(smc, key, &actual)) continue;
        snprintf(key, sizeof key, "F%dMx", i);
        if (!smc_number(smc, key, &maximum) || maximum <= 0) continue;
        if (actual / maximum * 100 > top) top = actual / maximum * 100;
      }
      if (top < 0) printf("unknown\n");
      else printf("%d\n", (int)(top + 0.5));
    }
    if (smc) IOServiceClose(smc);
    return 0;
  }
  printf("{\"hid\":");
  print_hid();
  printf(",\"smc\":%s,\"fanCount\":%d,\"fans\":[", smc && count >= 0 ? "true" : "false", count < 0 ? -1 : (int)count);
  for (int i = 0; i < (int)count && i < 8; i++) {
    char key[5];
    double actual = -1, minimum = -1, maximum = -1, mode = 0;
    snprintf(key, sizeof key, "F%dAc", i);
    smc_number(smc, key, &actual);
    snprintf(key, sizeof key, "F%dMn", i);
    smc_number(smc, key, &minimum);
    snprintf(key, sizeof key, "F%dMx", i);
    smc_number(smc, key, &maximum);
    snprintf(key, sizeof key, "F%dmd", i);
    if (!smc_number(smc, key, &mode)) {
      snprintf(key, sizeof key, "F%dMd", i);
      smc_number(smc, key, &mode);
    }
    printf("%s{\"ac\":%.1f,\"mn\":%.1f,\"mx\":%.1f,\"md\":%d}", i ? "," : "", actual, minimum, maximum, (int)mode);
  }
  printf("]}\n");
  if (smc) IOServiceClose(smc);
  return 0;
}
`;
