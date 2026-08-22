package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.AgentSettings;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.link.LinkClient;
import fi.natroutter.fenpos.link.LinkDispatcher;
import fi.natroutter.fenpos.pair.PairingException;
import fi.natroutter.fenpos.pair.PairingService;
import fi.natroutter.fenpos.print.JobSettings;
import fi.natroutter.fenpos.store.AgentIdentity;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Forgets this agent's credential and drops the link.
 * <p>
 * Local only, and the wording says so. Clearing the credential here stops this agent
 * connecting, but the server keeps its record until an operator unpairs there too — which is the
 * correct split, because an agent cannot be trusted to revoke its own access and revocation
 * needs to be visible where someone is looking.
 */
public class UnpairCommand implements Command {

    private final ConsoleOutput out;
    private final PairingService pairing;
    private final LinkClient link;
    private final LinkDispatcher.ConfigListener applyConfig;

    /**
     * @param out     output sink
     * @param pairing the shared pairing implementation
     * @param link    the connection to stop
     * @param applyConfig adopts a device set, job settings and agent settings; given an empty
     *                    device set, {@link JobSettings#DEFAULTS} and {@link AgentSettings#DEFAULTS}
     *                    to release the printers that belonged to the server being left and stop
     *                    following settings that server pushed
     */
    public UnpairCommand(ConsoleOutput out,
                         PairingService pairing,
                         LinkClient link,
                         LinkDispatcher.ConfigListener applyConfig) {
        this.out = Objects.requireNonNull(out, "out");
        this.pairing = Objects.requireNonNull(pairing, "pairing");
        this.link = Objects.requireNonNull(link, "link");
        this.applyConfig = Objects.requireNonNull(applyConfig, "applyConfig");
    }

    @Override
    public String name() {
        return "unpair";
    }

    @Override
    public String description() {
        return "Forget this agent's credential and disconnect";
    }

    @Override
    public void execute(String[] args) {
        try {
            Optional<AgentIdentity> cleared = pairing.unpair();
            if (cleared.isEmpty()) {
                out.println("This agent is not paired.");
                return;
            }

            link.stop("unpaired at the agent console");
            // Through the same seam a config.sync takes, so the ports close and the queues
            // drain exactly as they would if the server had removed every device. Job and agent
            // settings reset to their defaults too: with no server left to push them, this agent
            // is unconfigured again exactly as it was before its first config.sync.
            applyConfig.accept(List.of(), JobSettings.DEFAULTS, AgentSettings.DEFAULTS);

            out.println("Unpaired from " + cleared.get().serverUrl() + ".");
            out.println("The server still lists this agent; remove it there too, under Agents.");
        } catch (PairingException e) {
            out.println(e.getMessage());
        }
    }
}
