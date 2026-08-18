package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Shared behaviour for commands whose first argument names a device.
 * <p>
 * Every such command needs the same three things — completion over device names, a lookup
 * that reports an unknown name usefully, and a usage message — so they live here rather
 * than being repeated a dozen times.
 */
abstract class DeviceCommand implements Command {

    /** Where to write command output. */
    protected final ConsoleOutput out;

    /** The print service, for queues and job records. */
    protected final PrintService printing;

    /**
     * @param out      output sink
     * @param printing the print service
     */
    protected DeviceCommand(ConsoleOutput out, PrintService printing) {
        this.out = Objects.requireNonNull(out, "out");
        this.printing = Objects.requireNonNull(printing, "printing");
    }

    /** Returns every configured device name. */
    protected List<String> deviceNames() {
        return List.copyOf(printing.config().devices().keySet());
    }

    @Override
    public List<String> complete(String[] args) {
        return args.length == 0 ? deviceNames() : List.of();
    }

    /**
     * Resolves the device named by the first argument, reporting problems to the console.
     *
     * @param args the command's arguments
     * @return the device, or empty if the name is missing or unknown, in which case a
     *         message has already been written
     */
    protected Optional<DeviceSettings> resolveDevice(String[] args) {
        if (args.length == 0) {
            out.println("Usage: " + usage());
            return Optional.empty();
        }
        Optional<DeviceSettings> device = printing.config().device(args[0]);
        if (device.isEmpty()) {
            out.println("Unknown device '" + args[0] + "'. Configured: "
                    + String.join(", ", deviceNames()));
        }
        return device;
    }
}
