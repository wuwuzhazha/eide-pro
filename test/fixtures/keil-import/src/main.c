#include <stdint.h>

#include "app_config.h"

#ifndef TARGET_DEFINE
#error "target level define from the Keil target was not imported"
#endif

#ifndef GROUP_DEFINE
#error "group level define from the Keil source group was not imported"
#endif

#ifndef FILE_DEFINE
#error "file level define from the Keil file option was not imported"
#endif

volatile uint32_t counter;

int main(void)
{
    counter = APP_BASE + TARGET_DEFINE + GROUP_DEFINE + FILE_DEFINE;
    for (;;) {
        counter++;
    }
}
