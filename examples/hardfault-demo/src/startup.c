typedef unsigned int u32;
extern u32 _estack;
extern u32 _sidata;
extern u32 _sdata;
extern u32 _edata;
extern u32 _sbss;
extern u32 _ebss;
extern int main(void);
void Reset_Handler(void);
void HardFault_Handler(void);

__attribute__((section(".isr_vector"), used))
void (* const g_vectors[])(void) = {
    (void (*)(void))&_estack,
    Reset_Handler,
    HardFault_Handler,
    HardFault_Handler
};

void Reset_Handler(void)
{
    u32 *source = &_sidata;
    u32 *destination = &_sdata;
    while (destination < &_edata) { *destination++ = *source++; }
    for (destination = &_sbss; destination < &_ebss;) { *destination++ = 0; }
    main();
    for (;;) {}
}

__attribute__((naked)) void HardFault_Handler(void)
{
    __asm volatile ("bkpt #0\n\tb .\n");
}
