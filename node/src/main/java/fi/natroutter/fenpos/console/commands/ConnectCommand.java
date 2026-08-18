package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;

import java.util.Objects;

/** Opens a device's serial port by hand. */
public class ConnectCommand extends DeviceCommand {

    private final DeviceConnectionManager connections;

    /**
     * @param out         output sink
     * @param printing    the print service
     * @param connections the serial layer
     */
    public ConnectCommand(ConsoleOutput out,
                          PrintService printing,
                          DeviceConnectionManager connections) {
        super(out, printing);
        this.connections = Objects.requireNonNull(connections, "connections");
    }

    @Override
    public String name() {
        return "connect";
    }

    @Override
    public String description() {
        return "Open a device's serial port";
    }

    @Override
    public String usage() {
        return "connect <device>";
    }

    @Override
    public void execute(String[] args) {
        resolveDevice(args).ifPresent(device ->
                connections.handler(device.name()).ifPresent(handler -> {
                    handler.connect();
                    out.println(device.name() + ": " + handler.status().getLabel());
                }));
    }
}
