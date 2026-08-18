package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;

import java.util.List;
import java.util.Objects;

/**
 * Shuts the daemon down cleanly.
 * <p>
 * Preferable to Ctrl-C: in-flight writes are given their grace period to finish, so the
 * process does not exit with a printer holding half a receipt.
 */
public class StopCommand implements Command {

    private final ConsoleOutput out;
    private final Runnable shutdown;

    /**
     * @param out      output sink
     * @param shutdown the shutdown routine to invoke
     */
    public StopCommand(ConsoleOutput out, Runnable shutdown) {
        this.out = Objects.requireNonNull(out, "out");
        this.shutdown = Objects.requireNonNull(shutdown, "shutdown");
    }

    @Override
    public String name() {
        return "stop";
    }

    @Override
    public List<String> aliases() {
        return List.of("exit", "quit");
    }

    @Override
    public String description() {
        return "Drain in-flight jobs and shut down";
    }

    @Override
    public void execute(String[] args) {
        out.println("Stopping; draining in-flight jobs...");
        // Run off the console thread so the read loop is not the thing being torn down
        // while it is still executing this command.
        Thread.ofVirtual().name("thermapi-stop").start(() -> {
            shutdown.run();
            System.exit(0);
        });
    }
}
