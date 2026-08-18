package fi.natroutter.fenpos.config;

import fi.natroutter.fenpos.config.data.Config;
import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link ConfigResolver}.
 * <p>
 * Each test starts from a fully valid configuration and breaks exactly one thing, so a
 * failure identifies the specific rule that regressed rather than a general parse problem.
 */
class ConfigResolverTest {

    @Test
    void acceptsValidConfiguration() throws Exception {
        ConfigResolver.resolve(validConfig(device -> {
        }));
    }

    @Test
    void rejectsDeviceWithBlankPort() {
        Config config = validConfig(device -> device.setPort("   "));

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen.port"),
                () -> "expected a problem for devices.kitchen.port, got " + thrown.problems());
    }

    @Test
    void rejectsDeviceWithoutAuthKey() {
        Config config = validConfig(device -> device.setAuthKey(null));

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen.authKey"),
                () -> "expected a problem for devices.kitchen.authKey, got " + thrown.problems());
    }

    @Test
    void rejectsAuthKeyShorterThanSixteenCharacters() {
        Config config = validConfig(device -> device.setAuthKey("0123456789abcde"));

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen.authKey"),
                () -> "expected a problem for devices.kitchen.authKey, got " + thrown.problems());
    }

    @Test
    void acceptsAuthKeyOfExactlySixteenCharacters() throws Exception {
        ConfigResolver.resolve(validConfig(device -> device.setAuthKey("0123456789abcdef")));
    }

    @Test
    void rejectsNonPositiveColumns() {
        Config config = validConfig(device -> device.setColumns(0));

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen.columns"),
                () -> "expected a problem for devices.kitchen.columns, got " + thrown.problems());
    }

    @Test
    void rejectsUnknownCodepage() {
        Config config = validConfig(device -> device.setCodepage("CP9999"));

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen.codepage"),
                () -> "expected a problem for devices.kitchen.codepage, got " + thrown.problems());
    }

    @Test
    void rejectsUnknownParity() {
        Config config = validConfig(device -> device.setParity("SIDEWAYS"));

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen.parity"),
                () -> "expected a problem for devices.kitchen.parity, got " + thrown.problems());
    }

    @Test
    void rejectsConfigurationWithNoDevices() {
        Config config = validConfig(device -> {
        });
        config.setDevices(new LinkedHashMap<>());

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices"),
                () -> "expected a problem for devices, got " + thrown.problems());
    }

    /**
     * Two devices sharing a key would make the credential ambiguous: a key is the only
     * thing distinguishing who may print where, so a shared key silently grants access to
     * both printers.
     */
    @Test
    void rejectsAuthKeyReusedAcrossDevices() {
        Config config = validConfig(device -> {
        });
        Config.Device second = new Config.Device();
        second.setPort("COM4");
        second.setColumns(32);
        second.setCodepage("CP858");
        second.setAuthKey(config.getDevices().get("kitchen").getAuthKey());
        config.getDevices().put("bar", second);

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.bar.authKey"),
                () -> "expected a problem for devices.bar.authKey, got " + thrown.problems());
    }

    /** All defects are reported together so one restart surfaces everything that is wrong. */
    @Test
    void reportsEveryProblemRatherThanOnlyTheFirst() {
        Config config = validConfig(device -> {
            device.setPort(null);
            device.setAuthKey(null);
            device.setColumns(-5);
        });

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertEquals(3, thrown.problems().size(),
                () -> "expected all three defects, got " + thrown.problems());
    }

    /**
     * A device naming only the four required settings must still be fully usable, because
     * the documented defaults are what make a minimal config file possible.
     */
    @Test
    void appliesDocumentedDefaultsWhenDeviceOmitsOptionalSettings() throws Exception {
        ResolvedConfig resolved = ConfigResolver.resolve(validConfig(device -> {
        }));

        DeviceSettings kitchen = resolved.devices().get("kitchen");
        assertEquals(9600, kitchen.serial().baudRate());
        assertEquals(8, kitchen.serial().dataBits());
        assertEquals(1, kitchen.serial().stopBits());
        assertEquals(Parity.NONE, kitchen.serial().parity());
        assertEquals(FlowControl.NONE, kitchen.serial().flowControl());
        assertEquals(Duration.ofSeconds(5), kitchen.serial().reconnectDelay());
        assertEquals(Duration.ofMillis(5000), kitchen.serial().writeTimeout());

        assertEquals(Codepage.CP858, kitchen.print().codepage());
        assertEquals(UnsupportedPolicy.REJECT, kitchen.print().onUnsupported());
        assertEquals(Linefeed.LF, kitchen.print().defaultLinefeed());
        assertTrue(kitchen.print().defaultWrap());

        assertEquals(200, kitchen.limits().maxLines());
        assertEquals(300, kitchen.limits().maxOutputLines());
    }

    @Test
    void deviceLimitsOverrideGlobalLimits() throws Exception {
        Config config = validConfig(device -> {
            Config.Limits deviceLimits = new Config.Limits();
            deviceLimits.setMaxLines(50);
            device.setLimits(deviceLimits);
        });
        Config.Limits globalLimits = new Config.Limits();
        globalLimits.setMaxLines(150);
        globalLimits.setMaxOutputLines(250);
        config.setLimits(globalLimits);

        DeviceSettings kitchen = ConfigResolver.resolve(config).devices().get("kitchen");

        assertEquals(50, kitchen.limits().maxLines(), "device override should win");
        assertEquals(250, kitchen.limits().maxOutputLines(), "unset device value inherits global");
        assertEquals(256, kitchen.limits().maxLineChars(), "unset everywhere falls back to built-in");
    }

    /**
     * Device names appear in request paths, so a name containing a path separator or space
     * would produce a route that cannot be addressed.
     */
    @Test
    void rejectsDeviceNameThatIsNotUrlSafe() {
        Config config = validConfig(device -> {
        });
        Config.Device second = new Config.Device();
        second.setPort("COM4");
        second.setColumns(32);
        second.setCodepage("CP858");
        second.setAuthKey("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
        config.getDevices().put("kitchen/2", second);

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(hasProblemAt(thrown, "devices.kitchen/2"),
                () -> "expected a problem for devices.kitchen/2, got " + thrown.problems());
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    /**
     * Builds a configuration that passes validation, then applies {@code mutation} to its
     * single device so a test can invalidate one field at a time.
     *
     * @param mutation change to apply to the otherwise valid {@code kitchen} device
     * @return a configuration containing exactly one device named {@code kitchen}
     */
    private static Config validConfig(Consumer<Config.Device> mutation) {
        Config.HttpServer http = new Config.HttpServer();
        http.setEnabled(true);
        http.setHost("127.0.0.1");
        http.setPort(8080);

        Config.Device device = new Config.Device();
        device.setPort("COM3");
        device.setColumns(42);
        device.setCodepage("CP858");
        device.setAuthKey("f3a9c1d84b7e2065a1cf93be7d240c58");
        mutation.accept(device);

        LinkedHashMap<String, Config.Device> devices = new LinkedHashMap<>();
        devices.put("kitchen", device);

        Config config = new Config();
        config.setHttpServer(http);
        config.setDevices(devices);
        return config;
    }

    /** Returns {@code true} if {@code thrown} reports a problem for the given config path. */
    private static boolean hasProblemAt(ConfigurationException thrown, String path) {
        return thrown.problems().stream().anyMatch(problem -> problem.path().equals(path));
    }
}
