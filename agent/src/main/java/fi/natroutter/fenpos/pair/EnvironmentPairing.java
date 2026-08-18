package fi.natroutter.fenpos.pair;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.store.AgentIdentity;

import java.util.Objects;
import java.util.Optional;
import java.util.function.UnaryOperator;

/**
 * Pairs from the environment on first boot, which is how a container gets its credential.
 * <p>
 * The alternative is {@code docker exec} into a running container to type a command, which is a
 * poor first-run experience and easy to get wrong. The operator is already editing
 * {@code compose.yaml} for the device mapping and the {@code dialout} group, so two more lines
 * cost nothing:
 *
 * <pre>
 * environment:
 *   FENPOS_SERVER: https://fenpos.example.com
 *   FENPOS_PAIR_CODE: AG7K-2M9P-X4TR
 * </pre>
 *
 * Leaving the code in the file afterwards is harmless: it is single-use and consumed at
 * redemption, so a committed {@code compose.yaml} leaks something already spent.
 * <p>
 * <strong>Nothing here ever stops the process.</strong> A printer agent that exits on a missing
 * or expired code just restart-loops in Docker and buries the reason in a wall of repeated
 * startup logs. It reports what to do and carries on with no devices instead, which is a state
 * an operator can see in the panel and fix.
 */
public final class EnvironmentPairing {

    /** Environment variable naming the server to pair with. */
    public static final String SERVER_VARIABLE = "FENPOS_SERVER";

    /** Environment variable carrying the single-use pairing code. */
    public static final String CODE_VARIABLE = "FENPOS_PAIR_CODE";

    private final PairingService pairing;
    private final FoxLogger logger;
    private final UnaryOperator<String> environment;

    /**
     * @param pairing the shared pairing implementation
     * @param logger  where the outcome is reported
     */
    public EnvironmentPairing(PairingService pairing, FoxLogger logger) {
        this(pairing, logger, System::getenv);
    }

    /**
     * @param pairing     the shared pairing implementation
     * @param logger      where the outcome is reported
     * @param environment reads an environment variable; supplied by tests
     */
    EnvironmentPairing(PairingService pairing, FoxLogger logger, UnaryOperator<String> environment) {
        this.pairing = Objects.requireNonNull(pairing, "pairing");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.environment = Objects.requireNonNull(environment, "environment");
    }

    /**
     * Decides what to do about pairing on this boot, and reports it.
     *
     * @return the identity this agent should connect with, or empty when it has none
     */
    public Optional<AgentIdentity> resolve() {
        Optional<AgentIdentity> stored;
        try {
            stored = pairing.identity();
        } catch (PairingException e) {
            logger.error("Could not read the stored credential: " + e.getMessage());
            return Optional.empty();
        }

        String server = value(SERVER_VARIABLE);
        String code = value(CODE_VARIABLE);

        if (stored.isPresent()) {
            if (code != null) {
                // Said out loud rather than passed over. Silence here would look exactly like a
                // successful re-pair, and an operator who changed the code expecting it to take
                // effect would have no way to tell that it had not.
                logger.info("Already paired as '" + stored.get().agentName() + "'; ignoring "
                        + CODE_VARIABLE + ". Run 'unpair' first to pair with a different server.");
            }
            return stored;
        }

        if (server == null || code == null) {
            logger.warn("Not paired, and no pairing details in the environment. Set "
                    + SERVER_VARIABLE + " and " + CODE_VARIABLE + " and restart, or run "
                    + "'pair <server-url> <code>' on this console. Generate a code in the panel "
                    + "under Agents.");
            return Optional.empty();
        }

        try {
            AgentIdentity identity = pairing.pair(server, code);
            logger.info("Paired as '" + identity.agentName() + "' to " + identity.serverUrl());
            return Optional.of(identity);
        } catch (PairingException e) {
            // Reported plainly enough to act on: regenerate in the panel, update the value,
            // restart. Not fatal, for the reason in the class documentation.
            logger.error("Pairing from the environment failed: " + e.getMessage());
            return Optional.empty();
        }
    }

    /** Reads a variable, treating blank as absent so an empty compose value is not a code. */
    private String value(String name) {
        String raw = environment.apply(name);
        return raw == null || raw.isBlank() ? null : raw.trim();
    }
}
