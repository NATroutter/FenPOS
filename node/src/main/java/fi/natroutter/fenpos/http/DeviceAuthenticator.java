package fi.natroutter.fenpos.http;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Objects;
import java.util.Optional;

/**
 * Decides whether a request may act on the device it names.
 * <p>
 * Every device carries its own bearer key, so the credential and the device in the path
 * have to agree. Keys are compared with {@link MessageDigest#isEqual}, which does not stop
 * at the first differing byte; ordinary string equality would let an attacker recover a key
 * one character at a time by measuring response times.
 * <p>
 * <strong>Resolution order.</strong> The status returned depends on what the caller has
 * already proven:
 * <ol>
 *   <li>No usable {@code Bearer} credential — {@code 401 missing_key}.</li>
 *   <li>A key matching no device — {@code 401 invalid_key}, whatever device was named.
 *       An unknown device must be indistinguishable from a wrong key here, or the endpoint
 *       becomes a device-name oracle for anyone who can reach it.</li>
 *   <li>A valid key naming a device it does not own, or a device that does not exist —
 *       {@code 404 unknown_device}. The caller has proven they are a legitimate client, so
 *       a precise answer helps them find a typo without telling an outsider anything.</li>
 * </ol>
 */
public class DeviceAuthenticator {

    private static final String BEARER_PREFIX = "bearer ";

    private final ResolvedConfig config;

    /**
     * @param config the resolved configuration holding each device's key
     */
    public DeviceAuthenticator(ResolvedConfig config) {
        this.config = Objects.requireNonNull(config, "config");
    }

    /**
     * Authorises a request for a device.
     *
     * @param authorizationHeader the raw {@code Authorization} header; may be {@code null}
     * @param deviceName          the device named in the request path
     * @return the settings of the authorised device
     * @throws AuthException if the credential is absent, unrecognised, or not valid for the
     *                       named device
     */
    public DeviceSettings authorize(String authorizationHeader, String deviceName)
            throws AuthException {
        DeviceSettings owner = identify(authorizationHeader);

        if (!owner.name().equals(deviceName)) {
            throw new AuthException("unknown_device", 404,
                    "No device named '" + deviceName + "' is accessible with this key");
        }
        return owner;
    }

    /**
     * Resolves a credential to the device that owns it, without checking any path.
     * <p>
     * Used by endpoints whose path carries no device name, such as {@code /jobs/<id>},
     * where the key alone identifies the caller and then scopes what they may see.
     *
     * @param authorizationHeader the raw {@code Authorization} header; may be {@code null}
     * @return the settings of the device owning the key
     * @throws AuthException if the credential is absent or unrecognised
     */
    public DeviceSettings identify(String authorizationHeader) throws AuthException {
        String key = extractBearerKey(authorizationHeader);
        return deviceHoldingKey(key).orElseThrow(() -> new AuthException(
                "invalid_key", 401, "The supplied key is not valid for any device"));
    }

    /**
     * Returns the device whose key matches, comparing against every configured device.
     * <p>
     * The loop runs to completion rather than returning early so the work done does not
     * depend on which device matched.
     */
    private Optional<DeviceSettings> deviceHoldingKey(String key) {
        byte[] presented = key.getBytes(StandardCharsets.UTF_8);
        DeviceSettings matched = null;
        for (DeviceSettings device : config.devices().values()) {
            byte[] expected = device.authKey().getBytes(StandardCharsets.UTF_8);
            if (MessageDigest.isEqual(presented, expected)) {
                matched = device;
            }
        }
        return Optional.ofNullable(matched);
    }

    private static String extractBearerKey(String header) throws AuthException {
        if (header == null || header.isBlank()) {
            throw new AuthException("missing_key", 401,
                    "An Authorization: Bearer <key> header is required");
        }
        if (!header.toLowerCase().startsWith(BEARER_PREFIX)) {
            throw new AuthException("missing_key", 401,
                    "Authorization must use the Bearer scheme");
        }
        String key = header.substring(BEARER_PREFIX.length()).strip();
        if (key.isEmpty()) {
            throw new AuthException("missing_key", 401, "The Bearer key is empty");
        }
        return key;
    }
}
