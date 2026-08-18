package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.print.PrintQueue;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;

import java.util.Collection;
import java.util.Objects;
import java.util.Optional;

/** Shows every printer the server has assigned to this agent, and its current state. */
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
        return "List this agent's printers and their state";
    }

    @Override
    public void execute(String[] args) {
        Collection<Device> devices = printing.devices().all();
        if (devices.isEmpty()) {
            out.println("No devices. The server pushes them once this agent is paired and linked.");
            return;
        }

        out.println(String.format("%-12s %-14s %-14s %5s %-9s %6s %s",
                "NAME", "PORT", "STATE", "COLS", "CODEPAGE", "QUEUE", "PAUSED"));

        for (Device device : devices) {
            Optional<PrintQueue> queue = printing.findQueue(device.name());
            out.println(String.format("%-12s %-14s %-14s %5d %-9s %6s %s",
                    device.name(),
                    device.serial().port(),
                    connections.status(device.name()).name(),
                    device.print().columns(),
                    device.print().codepage().name(),
                    queue.map(q -> String.valueOf(q.depth())).orElse("-"),
                    queue.map(q -> q.isPaused() ? "yes" : "no").orElse("-")));
        }
    }
}
