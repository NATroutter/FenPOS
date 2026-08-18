package fi.natroutter.fenpos.config.data;

/**
 * Fully resolved HTTP listener settings.
 *
 * @param enabled        whether the listener starts at all
 * @param host           interface to bind; {@code 0.0.0.0} is required in a container,
 *                       because a published port maps to the container's external
 *                       interface rather than its loopback
 * @param port           TCP port to bind
 * @param publicAddress  base URL used only to render absolute route URLs in the startup
 *                       log; never used for routing
 */
public record HttpSettings(
        boolean enabled,
        String host,
        int port,
        String publicAddress) {
}
