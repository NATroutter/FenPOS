package fi.natroutter.fenpos.http;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.HttpSettings;
import fi.natroutter.fenpos.config.data.JobSettings;
import fi.natroutter.fenpos.config.data.LimitSettings;
import fi.natroutter.fenpos.config.data.PrintSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.config.data.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Behavioural tests for {@link DeviceAuthenticator}.
 * <p>
 * These pin the resolution order, which is a security property rather than a convenience:
 * the choice of status and code is what stops an unauthenticated caller enumerating device
 * names while still letting an authenticated operator debug a typo.
 */
class DeviceAuthenticatorTest {

    private static final String KITCHEN_KEY = "f3a9c1d84b7e2065a1cf93be7d240c58";
    private static final String BAR_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

    private final DeviceAuthenticator authenticator = new DeviceAuthenticator(config());

    @Test
    void acceptsTheKeyBelongingToTheRequestedDevice() throws Exception {
        DeviceSettings device = authenticator.authorize("Bearer " + KITCHEN_KEY, "kitchen");

        assertEquals("kitchen", device.name());
    }

    @Test
    void acceptsTheSchemeCaseInsensitively() throws Exception {
        assertEquals("kitchen",
                authenticator.authorize("bearer " + KITCHEN_KEY, "kitchen").name());
    }

    @Test
    void rejectsAMissingHeader() {
        AuthException thrown = assertThrows(AuthException.class,
                () -> authenticator.authorize(null, "kitchen"));

        assertEquals("missing_key", thrown.apiCode());
        assertEquals(401, thrown.status());
    }

    @Test
    void rejectsAHeaderThatIsNotBearer() {
        AuthException thrown = assertThrows(AuthException.class,
                () -> authenticator.authorize("Basic " + KITCHEN_KEY, "kitchen"));

        assertEquals("missing_key", thrown.apiCode());
    }

    @Test
    void rejectsAnEmptyKey() {
        assertEquals("missing_key",
                assertThrows(AuthException.class,
                        () -> authenticator.authorize("Bearer   ", "kitchen")).apiCode());
    }

    @Test
    void rejectsAKeyThatMatchesNoDevice() {
        AuthException thrown = assertThrows(AuthException.class,
                () -> authenticator.authorize("Bearer " + "9".repeat(32), "kitchen"));

        assertEquals("invalid_key", thrown.apiCode());
        assertEquals(401, thrown.status());
    }

    /**
     * A valid key naming someone else's device is a 404 rather than a 403: the caller has
     * proven they are a legitimate client, so a precise answer helps them, and 403 would
     * confirm the other device exists.
     */
    @Test
    void rejectsAValidKeyUsedForAnotherDevice() {
        AuthException thrown = assertThrows(AuthException.class,
                () -> authenticator.authorize("Bearer " + BAR_KEY, "kitchen"));

        assertEquals("unknown_device", thrown.apiCode());
        assertEquals(404, thrown.status());
    }

    @Test
    void rejectsAnUnknownDeviceForAnOtherwiseValidKey() {
        AuthException thrown = assertThrows(AuthException.class,
                () -> authenticator.authorize("Bearer " + KITCHEN_KEY, "cellar"));

        assertEquals("unknown_device", thrown.apiCode());
        assertEquals(404, thrown.status());
    }

    /**
     * An unknown device must look identical to a wrong key when the caller has not proven
     * anything, or the endpoint becomes a device-name oracle for anyone on the network.
     */
    @Test
    void anUnknownDeviceWithAnUnknownKeyLooksLikeABadKey() {
        AuthException thrown = assertThrows(AuthException.class,
                () -> authenticator.authorize("Bearer " + "9".repeat(32), "cellar"));

        assertEquals("invalid_key", thrown.apiCode());
        assertEquals(401, thrown.status());
    }

    @Test
    void identifiesTheDeviceOwningAKeyWithoutCheckingAPath() throws Exception {
        assertEquals("bar", authenticator.identify("Bearer " + BAR_KEY).name());
    }

    @Test
    void identifyRejectsAnUnknownKey() {
        assertEquals("invalid_key",
                assertThrows(AuthException.class,
                        () -> authenticator.identify("Bearer " + "9".repeat(32))).apiCode());
    }

    private static ResolvedConfig config() {
        Map<String, DeviceSettings> devices = new LinkedHashMap<>();
        devices.put("kitchen", device("kitchen", KITCHEN_KEY));
        devices.put("bar", device("bar", BAR_KEY));
        return new ResolvedConfig(
                new HttpSettings(true, "127.0.0.1", 8080, null),
                JobSettings.DEFAULTS,
                devices);
    }

    private static DeviceSettings device(String name, String key) {
        return new DeviceSettings(name, key,
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        true, true, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(42, Codepage.CP858, UnsupportedPolicy.REJECT, true, Linefeed.LF),
                LimitSettings.DEFAULTS);
    }
}
