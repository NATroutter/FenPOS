package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;

import java.util.Objects;

/** Shows every configured printer and its current state. */
public class DevicesCommand implements Command {

    private final ConsoleOutput out;
    private final PrintService printing;
    private final DeviceConnectionManager connections;

    /**
     * @param out         output sink
     * @param printing    the print service, for queue state
     * @param connections the serial layer, for connection state
     */
    public DevicesCommand(ConsoleOutput out,
                          PrintService printing,
                          DeviceConnectionManager connections) {
        this.out = Objects.requireNonNull(out, "out");
        this.printing = Objects.requireNonNull(printing, "printing");
        this.connections = Objects.requireNonNull(connections, "connections");
    }

    @Override
    public String name() {
        return "devices";
    }

    @Override
    public String description() {
        return "List configured printers and their state";
    }

    @Override
    public void execute(String[] args) {
        out.println(String.format("%-12s %-14s %-14s %5s %-9s %6s %s",
                "NAME", "PORT", "STATE", "COLS", "CODEPAGE", "QUEUE", "PAUSED"));

        for (DeviceSettings device : printing.config().devices().values()) {
            out.println(String.format("%-12s %-14s %-14s %5d %-9s %6d %s",
                    device.name(),
                    device.serial().port(),
                    connections.status(device.name()).name(),
                    device.print().columns(),
                    device.print().codepage().name(),
                    printing.queue(device.name()).depth(),
                    printing.queue(device.name()).isPaused() ? "yes" : "no"));
        }
    }
}
