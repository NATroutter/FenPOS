package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.config.ConfigProvider;
import fi.natroutter.fenpos.config.ConfigurationException;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;

import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * Validates {@code config.yaml} as it currently is on disk, without applying it.
 * <p>
 * Named for what it does. Settings take effect at startup, so this exists to answer "will
 * the daemon come back up if I restart it now?" while it is still running — turning a
 * failed restart into a message you can act on first.
 */
public class CheckConfigCommand implements Command {

    private final ConsoleOutput out;
    private final ConfigProvider configProvider;
    private final ResolvedConfig running;

    /**
     * @param out            output sink
     * @param configProvider reads and validates the file
     * @param running        the configuration currently in effect, for comparison
     */
    public CheckConfigCommand(ConsoleOutput out,
                              ConfigProvider configProvider,
                              ResolvedConfig running) {
        this.out = Objects.requireNonNull(out, "out");
        this.configProvider = Objects.requireNonNull(configProvider, "configProvider");
        this.running = Objects.requireNonNull(running, "running");
    }

    @Override
    public String name() {
        return "checkconfig";
    }

    @Override
    public String description() {
        return "Validate config.yaml on disk (applies at restart)";
    }

    @Override
    public void execute(String[] args) {
        ResolvedConfig onDisk;
        try {
            onDisk = configProvider.checkOnDisk();
        } catch (ConfigurationException e) {
            out.println("config.yaml is NOT usable; restarting now would fail:");
            e.problems().forEach(problem -> out.println("  - " + problem));
            return;
        }

        out.println("config.yaml is valid (" + onDisk.devices().size() + " device(s)).");
        reportDeviceDifferences(onDisk);
        out.println("Changes take effect on restart; nothing has been applied.");
    }

    /**
     * Reports which devices differ from the running set.
     * <p>
     * Only membership is compared, not every setting: knowing a device would appear or
     * disappear is what determines whether a restart is disruptive, and a full field diff
     * would bury that.
     */
    private void reportDeviceDifferences(ResolvedConfig onDisk) {
        Set<String> added = new TreeSet<>(onDisk.devices().keySet());
        added.removeAll(running.devices().keySet());

        Set<String> removed = new TreeSet<>(running.devices().keySet());
        removed.removeAll(onDisk.devices().keySet());

        if (!added.isEmpty()) {
            out.println("  Would add:    " + String.join(", ", added));
        }
        if (!removed.isEmpty()) {
            out.println("  Would remove: " + String.join(", ", removed));
        }
        if (added.isEmpty() && removed.isEmpty()) {
            out.println("  Same devices as the running configuration.");
        }
    }
}
