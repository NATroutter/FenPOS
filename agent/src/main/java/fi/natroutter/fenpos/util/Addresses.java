package fi.natroutter.fenpos.util;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * Whether an address names this machine.
 *
 * <p>Shared by the two places that decide whether plain HTTP is acceptable — redeeming a pairing
 * code and opening the link — because the two must agree. An address the first accepts and the
 * second refuses is an agent that pairs and then never connects; the reverse is a credential
 * crossing a network in cleartext.
 *
 * <p>Decided on the parsed address rather than on the text, because a prefix is not an address:
 * anything beginning "127." would admit {@code 127.0.0.1.evil.example}, a name anyone can register.
 * A literal is required before {@link InetAddress} is asked, so no name server is consulted;
 * resolving here would trade a prefix bug for a rebinding one, where the answer depends on what DNS
 * says at the moment of the check rather than on what the operator typed.
 */
public final class Addresses {

    private Addresses() {
    }

    /**
     * @param host the host from an address
     * @return whether it is a loopback address
     */
    public static boolean isLoopback(String host) {
        if (host == null) {
            return false;
        }
        String bare = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1)
                : host;
        if (bare.equalsIgnoreCase("localhost")) {
            return true;
        }
        if (!isNumericAddress(bare)) {
            return false;
        }
        try {
            return InetAddress.getByName(bare).isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    /**
     * Whether a host is already written as an IP address, so that resolving it asks no name server.
     *
     * <p>A colon can only appear in an IPv6 literal. Otherwise every character has to be a digit or
     * a dot, which admits the shorthands {@code 127.1} and {@code 2130706433} alongside dotted
     * quads: those are genuinely loopback, and letting {@link InetAddress} decide is better than
     * reimplementing its arithmetic here. What matters is that a name never reaches it.
     */
    private static boolean isNumericAddress(String host) {
        if (host.isEmpty()) {
            return false;
        }
        if (host.indexOf(':') >= 0) {
            return true;
        }
        for (int index = 0; index < host.length(); index++) {
            char character = host.charAt(index);
            if (character != '.' && (character < '0' || character > '9')) {
                return false;
            }
        }
        return true;
    }
}
