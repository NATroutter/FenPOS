package fi.natroutter.fenpos.console;

import fi.natroutter.foxlib.logger.FoxLogger;
import org.jline.reader.EndOfFileException;
import org.jline.reader.LineReader;
import org.jline.reader.LineReaderBuilder;
import org.jline.reader.UserInterruptException;
import org.jline.terminal.Terminal;
import org.jline.terminal.TerminalBuilder;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Registry and read loop for the interactive console.
 * <p>
 * Registration mirrors the HTTP server's: hand it commands, then start it. Dispatch, help
 * and completion are all derived from the {@link Command} interface, so a new command needs
 * no changes here.
 * <p>
 * <strong>No terminal, no console.</strong> When there is no usable TTY — a container
 * started without one, a systemd unit, a piped stdin — the read loop does not start. A loop
 * reading a closed stdin returns end-of-file immediately and forever, which would spin a
 * core at 100% for the life of the process.
 */
public class ConsoleManager {

    private final ConsoleOutput output;
    private final FoxLogger logger;
    private final Map<String, Command> byName = new LinkedHashMap<>();

    private volatile boolean running;
    private Terminal terminal;
    private LineReader reader;

    /**
     * @param output the sink for command output, redirected to the terminal once started
     * @param logger logger for console lifecycle messages
     */
    public ConsoleManager(ConsoleOutput output, FoxLogger logger) {
        this.output = Objects.requireNonNull(output, "output");
        this.logger = Objects.requireNonNull(logger, "logger");
    }

    /**
     * Registers commands under their name and every alias.
     *
     * @throws IllegalStateException if two commands claim the same name, which would make
     *                               dispatch depend on registration order
     */
    public void register(Command... commands) {
        for (Command command : commands) {
            claim(command.name(), command);
            command.aliases().forEach(alias -> claim(alias, command));
        }
    }

    private void claim(String name, Command command) {
        Command existing = byName.putIfAbsent(name.toLowerCase(Locale.ROOT), command);
        if (existing != null) {
            throw new IllegalStateException(
                    "Console name '" + name + "' is claimed by both "
                            + existing.getClass().getSimpleName() + " and "
                            + command.getClass().getSimpleName());
        }
    }

    /** Returns every registered command, without alias duplicates, in registration order. */
    public List<Command> commands() {
        return byName.values().stream().distinct().toList();
    }

    /**
     * Finds a command by name or alias.
     *
     * @param name the typed name; case-insensitive
     */
    public Optional<Command> find(String name) {
        return name == null
                ? Optional.empty()
                : Optional.ofNullable(byName.get(name.toLowerCase(Locale.ROOT)));
    }

    /**
     * Starts the read loop on a background thread, if a usable terminal exists.
     *
     * @return whether the console started
     */
    public boolean start() {
        try {
            terminal = TerminalBuilder.builder().name("FenPOS").system(true).build();
        } catch (IOException e) {
            logger.warn("Console unavailable (no terminal): " + e.getMessage());
            return false;
        }

        if (Terminal.TYPE_DUMB.equals(terminal.getType())) {
            logger.info("Console disabled: no interactive terminal. "
                    + "Run the container with a TTY to enable it.");
            closeTerminal();
            return false;
        }

        reader = LineReaderBuilder.builder()
                .terminal(terminal)
                .completer(new CommandCompleter(this))
                .build();

        // Log lines must be drawn above the prompt, or they overwrite whatever is being
        // typed. This is the whole reason the console owns the output sink.
        output.redirectTo(reader::printAbove);

        running = true;
        Thread.ofVirtual().name("fenpos-agent-console").start(this::readLoop);
        return true;
    }

    private void readLoop() {
        while (running) {
            String line;
            try {
                line = reader.readLine("fenpos> ");
            } catch (UserInterruptException e) {
                // Ctrl-C at an empty prompt: ignore rather than exit, so an operator cannot
                // kill a printer daemon by reflex.
                continue;
            } catch (EndOfFileException e) {
                // Ctrl-D or the stream closing: stop reading, but leave the daemon serving.
                logger.info("Console input closed; the agent keeps running");
                running = false;
                return;
            }
            dispatch(line);
        }
    }

    /**
     * Parses and runs one input line.
     *
     * @param line the raw input; blank lines are ignored
     */
    public void dispatch(String line) {
        if (line == null || line.isBlank()) {
            return;
        }
        String[] parts = line.strip().split("\\s+");
        String name = parts[0];
        String[] args = new String[parts.length - 1];
        System.arraycopy(parts, 1, args, 0, args.length);

        Optional<Command> command = find(name);
        if (command.isEmpty()) {
            output.println("Unknown command '" + name + "'." + suggestion(name));
            return;
        }
        try {
            command.get().execute(args);
        } catch (RuntimeException e) {
            // A broken command must not take the console down with it.
            logger.error("Command '" + name + "' failed", e);
            output.println("Command failed: " + e.getMessage());
        }
    }

    /** Suggests the closest registered name, so a typo does not need a help lookup. */
    private String suggestion(String typed) {
        String best = null;
        int bestDistance = Integer.MAX_VALUE;
        for (String candidate : byName.keySet()) {
            int distance = editDistance(typed.toLowerCase(Locale.ROOT), candidate);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }
        // Only offered when the typo is plausibly a typo rather than a different word.
        return best != null && bestDistance <= 3 ? " Did you mean '" + best + "'?" : "";
    }

    private static int editDistance(String left, String right) {
        int[] previous = new int[right.length() + 1];
        int[] current = new int[right.length() + 1];
        for (int j = 0; j <= right.length(); j++) {
            previous[j] = j;
        }
        for (int i = 1; i <= left.length(); i++) {
            current[0] = i;
            for (int j = 1; j <= right.length(); j++) {
                int substitution = previous[j - 1]
                        + (left.charAt(i - 1) == right.charAt(j - 1) ? 0 : 1);
                current[j] = Math.min(substitution, Math.min(previous[j] + 1, current[j - 1] + 1));
            }
            int[] swap = previous;
            previous = current;
            current = swap;
        }
        return previous[right.length()];
    }

    /** Stops the read loop and releases the terminal. */
    public void stop() {
        running = false;
        closeTerminal();
    }

    private void closeTerminal() {
        if (terminal != null) {
            try {
                terminal.close();
            } catch (IOException e) {
                logger.warn("Could not close the terminal: " + e.getMessage());
            }
            terminal = null;
        }
    }

    /** Returns completion candidates for a partially typed line. */
    List<String> completionsFor(List<String> words, int wordIndex) {
        if (wordIndex == 0) {
            return new ArrayList<>(byName.keySet());
        }
        return find(words.getFirst())
                .map(command -> command.complete(
                        words.subList(1, wordIndex).toArray(String[]::new)))
                .orElseGet(List::of);
    }
}
