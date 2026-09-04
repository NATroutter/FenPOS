package fi.natroutter.fenpos.console.commands;

import com.fazecast.jSerialComm.SerialPort;
import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.serial.SerialHandler;
import fi.natroutter.fenpos.util.Text;

import java.util.List;
import java.util.Objects;

/**
 * Lists the serial ports the operating system currently reports.
 * <p>
 * The first thing to run when a printer will not connect: it answers whether the device is
 * visible at all, and under what name, which is usually the whole problem.
 */
public class ScanCommand implements Command {

    private final ConsoleOutput out;

    /**
     * @param out output sink
     */
    public ScanCommand(ConsoleOutput out) {
        this.out = Objects.requireNonNull(out, "out");
    }

    @Override
    public String name() {
        return "scan";
    }

    @Override
    public String description() {
        return "List serial ports visible to the system";
    }

    @Override
    public void execute(String[] args) {
        List<SerialPort> ports = SerialHandler.availablePorts();
        if (ports.isEmpty()) {
            out.println("No serial ports found.");
            return;
        }

        out.println(String.format("%-12s %-28s %-10s %s",
                "PORT", "DESCRIPTION", "VID:PID", "SERIAL"));
        for (SerialPort port : ports) {
            out.println(String.format("%-12s %-28s %04X:%04X %s",
                    Text.safe(port.getSystemPortName()),
                    truncate(Text.safe(port.getPortDescription()), 28),
                    port.getVendorID(),
                    port.getProductID(),
                    blankToDash(Text.safe(port.getSerialNumber()))));
        }
    }

    private static String truncate(String value, int width) {
        if (value.isEmpty()) {
            return "-";
        }
        return value.length() <= width ? value : value.substring(0, width - 1) + "…";
    }

    private static String blankToDash(String value) {
        return value == null || value.isBlank() ? "-" : value;
    }
}
