package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.link.LinkClient;
import fi.natroutter.fenpos.link.LinkState;

import java.util.Objects;

/**
 * Shows whether this agent is talking to its server, and if not, what it is doing about it.
 * <p>
 * The first thing to run when jobs are not arriving. It distinguishes the three states that
 * look identical from the panel — never paired, paired but unreachable, connected but idle —
 * which is otherwise a guessing game conducted from the wrong end of the link.
 */
public class LinkCommand implements Command {

    private final ConsoleOutput out;
    private final LinkClient link;

    /**
     * @param out  output sink
     * @param link the connection to report on
     */
    public LinkCommand(ConsoleOutput out, LinkClient link) {
        this.out = Objects.requireNonNull(out, "out");
        this.link = Objects.requireNonNull(link, "link");
    }

    @Override
    public String name() {
        return "link";
    }

    @Override
    public String description() {
        return "Show the connection to the server";
    }

    @Override
    public void execute(String[] args) {
        LinkState state = link.state();
        out.println("Link:   " + state.label());

        String server = link.serverUrl();
        out.println("Server: " + (server == null ? "-" : server));

        switch (state) {
            case UNPAIRED -> out.println(
                    "Run 'pair <server-url> <code>' with a code from the panel, under Agents.");
            case CONNECTING -> {
                long failures = link.failedAttempts();
                out.println(failures == 0
                        ? "Dialling."
                        : failures + " attempt(s) have failed; retrying with a growing delay.");
            }
            case CONNECTED -> out.println("Devices and jobs arrive over this connection.");
            case IDLE -> out.println("Paired, but the link has not been started.");
            case STOPPED -> out.println("Stopped. The agent is shutting down or was unpaired.");
        }
    }
}
