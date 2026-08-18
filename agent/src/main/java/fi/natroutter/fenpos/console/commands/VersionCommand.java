package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.FenPOSAgent;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;

import java.util.Objects;

/** Reports the running build. */
public class VersionCommand implements Command {

    private final ConsoleOutput out;

    /**
     * @param out output sink
     */
    public VersionCommand(ConsoleOutput out) {
        this.out = Objects.requireNonNull(out, "out");
    }

    @Override
    public String name() {
        return "version";
    }

    @Override
    public String description() {
        return "Show the running version";
    }

    @Override
    public void execute(String[] args) {
        out.println("FenPOS agent " + FenPOSAgent.getVERSION()
                + " on Java " + Runtime.version().feature()
                + " (" + System.getProperty("os.name") + ")");
    }
}
