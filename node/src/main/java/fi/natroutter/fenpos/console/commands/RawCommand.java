package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import fi.natroutter.fenpos.serial.PrinterWriteException;

import java.util.Arrays;
import java.util.Objects;

/**
 * Writes arbitrary bytes straight to a device.
 * <p>
 * The one deliberate hole in the validation. Everything else refuses to emit control bytes,
 * which is what makes it impossible for a client to desynchronise the printer — so there
 * has to be one place to exercise a command ThermAPI does not model, whether to test
 * hardware or to work around a firmware quirk.
 * <p>
 * Console-only, and never reachable over HTTP. The write goes through the same lock the
 * queue uses, so it cannot interleave with a job that is mid-print.
 */
public class RawCommand extends DeviceCommand {

    private final DeviceConnectionManager connections;

    /**
     * @param out         output sink
     * @param printing    the print service
     * @param connections the serial layer
     */
    public RawCommand(ConsoleOutput out,
                      PrintService printing,
                      DeviceConnectionManager connections) {
        super(out, printing);
        this.connections = Objects.requireNonNull(connections, "connections");
    }

    @Override
    public String name() {
        return "raw";
    }

    @Override
    public String description() {
        return "Write raw hex bytes to a device, bypassing validation";
    }

    @Override
    public String usage() {
        return "raw <device> <hex bytes, e.g. 1B 40 1D 56 00>";
    }

    @Override
    public void execute(String[] args) {
        if (args.length < 2) {
            out.println("Usage: " + usage());
            return;
        }

        resolveDevice(args).ifPresent(device -> {
            byte[] payload;
            try {
                payload = parseHex(Arrays.copyOfRange(args, 1, args.length));
            } catch (IllegalArgumentException e) {
                out.println(e.getMessage());
                return;
            }

            connections.handler(device.name()).ifPresent(handler -> {
                try {
                    handler.write(payload);
                    out.println("Wrote " + payload.length + " byte(s) to " + device.name() + ".");
                } catch (PrinterWriteException e) {
                    out.println("Write failed: " + e.getMessage());
                }
            });
        });
    }

    /**
     * Parses hex byte tokens, tolerating an optional {@code 0x} prefix.
     *
     * @throws IllegalArgumentException if a token is not a byte, with the token named so the
     *                                  operator can see which one
     */
    private static byte[] parseHex(String[] tokens) {
        byte[] bytes = new byte[tokens.length];
        for (int index = 0; index < tokens.length; index++) {
            String token = tokens[index].toLowerCase().replaceFirst("^0x", "");
            int value;
            try {
                value = Integer.parseInt(token, 16);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException(
                        "'" + tokens[index] + "' is not a hex byte");
            }
            if (value < 0 || value > 0xFF) {
                throw new IllegalArgumentException(
                        "'" + tokens[index] + "' is outside 00..FF");
            }
            bytes[index] = (byte) value;
        }
        return bytes;
    }
}
