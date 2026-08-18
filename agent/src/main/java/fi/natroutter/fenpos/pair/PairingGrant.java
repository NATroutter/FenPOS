package fi.natroutter.fenpos.pair;

/**
 * What the server hands back when a pairing code is redeemed.
 *
 * @param agentId   this agent's server-side identifier
 * @param agentName the name the operator gave it, shown in the panel
 * @param token     the long-lived bearer credential; the server keeps only its hash
 */
public record PairingGrant(String agentId, String agentName, String token) {

    @Override
    public String toString() {
        // A grant reaching a log line would put the credential on disk, so the token is never
        // rendered. This is the whole reason the record does not use the generated toString.
        return "PairingGrant[agentId=" + agentId + ", agentName=" + agentName + ", token=***]";
    }
}
