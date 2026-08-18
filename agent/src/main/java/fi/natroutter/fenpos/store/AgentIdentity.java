package fi.natroutter.fenpos.store;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * Who this agent is, and where it reports.
 *
 * <p>Written once at pairing and read at every start. This is the only credential the agent
 * holds, and it is the reason the store needs to survive a container recreate: losing it means
 * the operator has to pair the site again.
 *
 * <p>A singleton, enforced by the fixed primary key rather than by convention. An agent that
 * somehow held two identities would connect as whichever row it read first, which is a failure
 * that would present as a printer intermittently belonging to the wrong site.
 */
@Entity
@Table(name = "agent_identity")
public class AgentIdentity {

    /** Fixed primary key of the singleton row. */
    public static final long SINGLETON_ID = 1L;

    @Id
    @Column(name = "id")
    private long id = SINGLETON_ID;

    /** Absolute URL of the FenPOS server, without a trailing slash. */
    @Column(name = "server_url", nullable = false)
    private String serverUrl;

    /** This agent's server-side identifier. */
    @Column(name = "agent_id", nullable = false)
    private String agentId;

    /** This agent's name, as shown in the panel. Cached for log lines only. */
    @Column(name = "agent_name", nullable = false)
    private String agentName;

    /**
     * The bearer token presented when connecting.
     *
     * <p>Held in the clear because the agent must be able to present it. There is nothing to
     * hash against: unlike the server, which only ever compares, the agent must reproduce it.
     * Protecting it is the filesystem's job — the store file is created with owner-only
     * permissions and lives on a volume the operator controls.
     */
    @Column(name = "token", nullable = false)
    private String token;

    /** When pairing completed. */
    @Column(name = "paired_at", nullable = false)
    private Instant pairedAt;

    /** Required by JPA. Not for application use. */
    protected AgentIdentity() {
    }

    /**
     * @param serverUrl absolute URL of the server, without a trailing slash
     * @param agentId   this agent's server-side identifier
     * @param agentName this agent's name, for log lines
     * @param token     the bearer token issued at pairing
     * @param pairedAt  when pairing completed
     */
    public AgentIdentity(String serverUrl, String agentId, String agentName, String token, Instant pairedAt) {
        this.id = SINGLETON_ID;
        this.serverUrl = serverUrl;
        this.agentId = agentId;
        this.agentName = agentName;
        this.token = token;
        this.pairedAt = pairedAt;
    }

    /** @return absolute URL of the server, without a trailing slash */
    public String serverUrl() {
        return serverUrl;
    }

    /** @return this agent's server-side identifier */
    public String agentId() {
        return agentId;
    }

    /** @return this agent's name, as shown in the panel */
    public String agentName() {
        return agentName;
    }

    /** @return the bearer token presented when connecting */
    public String token() {
        return token;
    }

    /** @return when pairing completed */
    public Instant pairedAt() {
        return pairedAt;
    }

    /**
     * Describes this identity without disclosing the token.
     *
     * <p>Overridden deliberately: the default record-style rendering would put the credential
     * into any log line that interpolated the object, which is exactly the accident that makes
     * a token turn up in a support bundle.
     *
     * @return a safe description
     */
    @Override
    public String toString() {
        return "AgentIdentity[agentId=" + agentId + ", agentName=" + agentName + ", serverUrl=" + serverUrl + "]";
    }
}
