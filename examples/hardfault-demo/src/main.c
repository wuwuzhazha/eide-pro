typedef struct {
    const char *name;
    void (*on_event)(void);
} Sensor;

static void temperature_ready(void) {}

static Sensor sensors[] = {
    { "temperature", temperature_ready },
    { "humidity", 0 },
};

static void poll(const Sensor *sensor)
{
    sensor->on_event();
}

int main(void)
{
    for (unsigned i = 0; i < sizeof(sensors) / sizeof(sensors[0]); i++) {
        poll(&sensors[i]);
    }
    for (;;) {}
}
