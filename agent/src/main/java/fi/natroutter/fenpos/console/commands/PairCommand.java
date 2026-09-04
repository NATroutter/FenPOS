package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.link.LinkClient;
import fi.natroutter.fenpos.pair.PairingException;
import fi.natroutter.fenpos.pair.PairingService;
import fi.natroutter.fenpos.store.AgentIdentity;
import fi.natroutter.fenpos.util.Text;

import java.util.Objects;
import java.util.Optional;

/**
 * Claims this agent for a server, using a code generated in the panel.
 * <p>
 * The route for bare metal, for re-pairing, and for recovery. Containers usually pair from
 * environment variables instead, but both call the same service — a second implementation here
 * would be a second chance to skip the https check or forget to persist the credential.
 */
public class PairCommand implements Command {

    private final ConsoleOutput out;
    private final PairingService pairing;
    private final LinkClient link;

    /**
     * @param out     output sink
     * @param pairing the shared pairing implementation
     * @param link    the connection to start once a credential exists
     */
    public PairCommand(ConsoleOutput out, PairingService pairing, LinkClient link) {
        this.out = Objects.requireNonNull(out, "out");
        this.pairing = Objects.requireNonNull(pairing, "pairing");
        this.link = Objects.requireNonNull(link, "link");
    }

    @Override
    public String name() {
        return "pair";
    }

    @Override
    public String description() {
        return "Claim this agent for a server using a code from the panel";
    }

    @Override
    public String usage() {
        return "pair <server-url> <code>";
    }

    @Override
    public void execute(String[] args) {
        if (args.length < 2) {
            out.println("Usage: " + usage());
            out.println("Generate a code in the panel under Agents, then run for example:");
            out.println("  pair https://fenpos.example.com AG7K-2M9P-X4TR");
            return;
        }

        Optional<AgentIdentity> existing;
        try {
            existing = pairing.identity();
        } catch (PairingException e) {
            out.println(e.getMessage());
            return;
        }

        if (existing.isPresent()) {
            // Refused rather than silently replaced. Re-pairing discards a working credential,
            // and a pairing code is single use, so getting this wrong costs a trip back to the
            // panel for a new one.
            out.println("Already paired as '" + Text.safe(existing.get().agentName()) + "' to "
                    + existing.get().serverUrl() + ".");
            out.println("Run 'unpair' first if you mean to pair with a different server.");
            return;
        }

        try {
            AgentIdentity identity = pairing.pair(args[0], args[1]);
            out.println("Paired as '" + Text.safe(identity.agentName()) + "' to " + identity.serverUrl() + ".");
            link.start(identity);
            out.println("Connecting; run 'link' to see the connection state.");
        } catch (PairingException e) {
            out.println(e.getMessage());
        }
    }
}
