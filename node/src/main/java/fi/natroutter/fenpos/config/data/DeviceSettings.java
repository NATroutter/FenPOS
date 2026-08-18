package fi.natroutter.fenpos.config.data;

/**
 * One fully resolved printer: every default applied, every enum parsed, nothing nullable.
 * <p>
 * Settings are grouped rather than flattened so each consumer depends only on the part it
 * uses — the serial layer takes {@link #serial()}, the compile pipeline takes
 * {@link #print()} and {@link #limits()} — which keeps those layers from reaching into
 * settings that are none of their business.
 *
 * @param name     device name as it appears in request paths
 * @param authKey  bearer credential accepted for this device; never logged
 * @param serial   serial port settings
 * @param print    printing and encoding settings
 * @param limits   request limits, with device overrides already merged over globals
 */
public record DeviceSettings(
        String name,
        String authKey,
        SerialSettings serial,
        PrintSettings print,
        LimitSettings limits) {

    @Override
    public String toString() {
        return "DeviceSettings[name=" + name
                + ", authKey=***"
                + ", serial=" + serial
                + ", print=" + print
                + ", limits=" + limits + "]";
    }
}
