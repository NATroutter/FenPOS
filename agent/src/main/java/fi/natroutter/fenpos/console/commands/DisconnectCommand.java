package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;

import java.util.Objects;

/**
 * Closes a device's serial port by hand.
 * <p>
 * Blocks until any write in progress finishes, so the printer is never left holding half an
 * ESC/POS command.
 */
public class DisconnectCommand extends DeviceCommand {

    private final DeviceConnectionManager connections;

    /**
     * @param out         output sink
     * @param printing    the print service
     * @param connections the serial layer
     */
    public DisconnectCommand(ConsoleOutput out,
                             PrintService printing,
                             DeviceConnectionManager connections) {
        super(out, printing);
        this.connections = Objects.requireNonNull(connections, "connections");
    }

    @Override
    public String name() {
        return "disconnect";
    }

    @Override
    public String description() {
        return "Close a device's serial port";
    }

    @Override
    public String usage() {
        return "disconnect <device>";
    }

    @Override
    public void execute(String[] args) {
        resolveDevice(args).ifPresent(device ->
                connections.handler(device.name()).ifPresent(handler -> {
                    handler.disconnect();
                    out.println(device.name() + ": " + handler.status().getLabel());
                }));
    }
}
