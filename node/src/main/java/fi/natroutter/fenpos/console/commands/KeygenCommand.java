package fi.natroutter.fenpos.console.commands;

import fi.natroutter.fenpos.console.Command;
import fi.natroutter.fenpos.console.ConsoleOutput;

import java.security.SecureRandom;
import java.util.Objects;

/**
 * Generates a device key.
 * <p>
 * Exists so nobody has to invent one. A key typed by a human tends to be short and
 * guessable, and this endpoint is potentially reachable from a network.
 */
public class KeygenCommand implements Command {

    /** 32 hex characters is 128 bits, which is far beyond brute-forcing over HTTP. */
    private static final int KEY_BYTES = 16;

    private final ConsoleOutput out;
    private final SecureRandom random = new SecureRandom();

    /**
     * @param out output sink
     */
    public KeygenCommand(ConsoleOutput out) {
        this.out = Objects.requireNonNull(out, "out");
    }

    @Override
    public String name() {
        return "keygen";
    }

    @Override
    public String description() {
        return "Generate a random authKey for config.yaml";
    }

    @Override
    public void execute(String[] args) {
        byte[] buffer = new byte[KEY_BYTES];
        random.nextBytes(buffer);
        StringBuilder key = new StringBuilder(KEY_BYTES * 2);
        for (byte value : buffer) {
            key.append(String.format("%02x", value));
        }
        out.println("authKey: \"" + key + "\"");
        out.println("Add this under the device in config.yaml, then restart.");
    }
}
