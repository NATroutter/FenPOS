package fi.natroutter.fenpos.pair;

import fi.natroutter.fenpos.link.AgentInfo;
import fi.natroutter.fenpos.store.AgentIdentity;
import fi.natroutter.fenpos.store.AgentStore;
import fi.natroutter.fenpos.store.StoreException;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Pairing, from code to persisted credential.
 * <p>
 * The single implementation behind both entry points — the {@code pair} console command and the
 * environment variables a container is started with. Two code paths would be two chances for
 * one of them to skip the scheme check, forget to persist, or store a different shape; there is
 * one here so there is nothing to keep in step.
 */
public class PairingService {

    private final AgentStore store;
    private final PairingClient client;
    private final AgentInfo info;

    /**
     * @param store  where the credential is persisted
     * @param client performs the redemption call
     * @param info   how this agent describes itself
     */
    public PairingService(AgentStore store, PairingClient client, AgentInfo info) {
        this.store = Objects.requireNonNull(store, "store");
        this.client = Objects.requireNonNull(client, "client");
        this.info = Objects.requireNonNull(info, "info");
    }

    /**
     * Redeems a code and persists the resulting credential.
     * <p>
     * Persisting is part of pairing rather than a step after it. A grant that was issued but not
     * stored is the worst outcome available: the server has marked the code consumed and the
     * agent has nothing, so the operator must generate a second code without being told why the
     * first appeared to work.
     *
     * @param serverUrl the server's base URL
     * @param code      the pairing code from the panel
     * @return the identity now stored
     * @throws PairingException when the code is refused, the server unreachable, or the
     *                          credential cannot be persisted
     */
    public AgentIdentity pair(String serverUrl, String code) throws PairingException {
        PairingGrant grant = client.redeem(serverUrl, code, info);

        AgentIdentity identity = new AgentIdentity(
                normalise(serverUrl),
                grant.agentId(),
                grant.agentName(),
                grant.token(),
                Instant.now());

        try {
            store.saveIdentity(identity);
        } catch (StoreException e) {
            throw new PairingException("Paired with the server, but the credential could not be "
                    + "saved: " + e.getMessage() + ". The code has been used, so generate a new "
                    + "one after fixing this.", e);
        }

        return identity;
    }

    /**
     * Forgets this agent's credential.
     * <p>
     * Local only. The server keeps its record until an operator unpairs there too, which is the
     * right split: an agent cannot be trusted to revoke its own access, and the panel is where
     * revocation is visible.
     *
     * @return the identity that was cleared, or empty if there was none
     * @throws PairingException when the store cannot be written
     */
    public Optional<AgentIdentity> unpair() throws PairingException {
        try {
            Optional<AgentIdentity> existing = store.identity();
            if (existing.isPresent()) {
                store.clearIdentity();
            }
            return existing;
        } catch (StoreException e) {
            throw new PairingException("Could not clear the stored credential: " + e.getMessage(), e);
        }
    }

    /**
     * Returns the stored identity, if this agent is paired.
     *
     * @return the identity, or empty when unpaired
     * @throws PairingException when the store cannot be read
     */
    public Optional<AgentIdentity> identity() throws PairingException {
        try {
            return store.identity();
        } catch (StoreException e) {
            throw new PairingException("Could not read the stored credential: " + e.getMessage(), e);
        }
    }

    /** Strips whitespace and any trailing slash, so the stored URL is a stable base. */
    private static String normalise(String serverUrl) {
        String trimmed = serverUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }
}
