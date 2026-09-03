package fi.natroutter.fenpos.console;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.Diagnostics;
import org.jline.reader.EndOfFileException;
import org.jline.reader.LineReader;
import org.jline.reader.LineReaderBuilder;
import org.jline.reader.UserInterruptException;
import org.jline.terminal.Terminal;
import org.jline.terminal.TerminalBuilder;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
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
 * <p>
 * <strong>A detach is not the end.</strong> Stdin reporting end-of-file — which is what
 * leaving a {@code docker attach} looks like from in here — rebuilds the reader rather
 * than abandoning the console, so the next attach gets a working prompt instead of one
 * that silently ignores everything typed at it. Repeated end-of-files in quick
 * succession still stop it, because those mean stdin is gone rather than detached.
 */
public class ConsoleManager {

    /** How many end-of-files in quick succession before the console gives up for good. */
    private static final int END_OF_FILE_BUDGET = 3;

    /** Within this, another end-of-file means stdin is closed rather than detached. */
    private static final Duration END_OF_FILE_WINDOW = Duration.ofSeconds(2);

    /** Pause before rebuilding the reader, so a closed stdin cannot spin a core. */
    private static final Duration END_OF_FILE_BACKOFF = Duration.ofMillis(500);

    private final ConsoleOutput output;
    private final FoxLogger logger;
    private final Map<String, Command> byName = new LinkedHashMap<>();

    private volatile boolean running;
    private Terminal terminal;
    private LineReader reader;
    private Instant lastEndOfFile;
    private int consecutiveEndOfFiles;
    private String openFailure;

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
        if (!openReader()) {
            logger.info("Console disabled: " + openFailure
                    + ". Run the container with a TTY to enable it.");
            return false;
        }

        running = true;
        Thread.ofVirtual().name("fenpos-agent-console").start(this::readLoop);
        return true;
    }

    /**
     * Builds the terminal and the line reader over the current stdin.
     * <p>
     * Separate from {@link #start()} because it runs again every time stdin is replaced,
     * which is what re-attaching to a container does.
     *
     * @return whether an interactive terminal was available; {@link #openFailure} says why
     *         not when it was not
     */
    private boolean openReader() {
        try {
            terminal = TerminalBuilder.builder().name("FenPOS").system(true).build();
        } catch (IOException e) {
            openFailure = "no terminal (" + e.getMessage() + ")";
            return false;
        }

        if (Terminal.TYPE_DUMB.equals(terminal.getType())) {
            openFailure = "no interactive terminal";
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
        openFailure = null;
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
                if (!reopenAfterEndOfFile()) {
                    return;
                }
                continue;
            }
            dispatch(line);
        }
    }

    /**
     * Rebuilds the reader after stdin reported end-of-file, when that is worth doing.
     * <p>
     * Detaching from a container ends this process's view of stdin. Treating that as final —
     * which it was — left the next {@code docker attach} looking at a prompt that silently
     * swallowed everything typed at it, with a restart of the whole agent the only way back.
     * A detach is not a reason to give up the console.
     * <p>
     * Bounded, because the hazard in the class documentation is real: stdin that is closed
     * rather than merely detached returns end-of-file instantly and forever, and rebuilding
     * around that would spin a core for the life of the process. The pause and the small
     * budget tell the two apart — an operator detaching does it once, and not again half a
     * second later.
     *
     * @return whether the console may keep reading
     */
    private boolean reopenAfterEndOfFile() {
        if (!worthReopening(Instant.now())) {
            logger.info("Console input is closed, not merely detached; the agent keeps running");
            stop();
            return false;
        }

        closeTerminal();
        try {
            Thread.sleep(END_OF_FILE_BACKOFF);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            stop();
            return false;
        }

        if (!openReader()) {
            logger.info("Console input closed (" + openFailure + "); the agent keeps running");
            stop();
            return false;
        }
        return true;
    }

    /**
     * Whether an end-of-file arriving now is a detach worth reopening for.
     * <p>
     * Handed the instant rather than reading the clock, and visible to the package, because
     * this is the one part of the recovery a test can exercise: a unit test cannot conjure a
     * pseudo-terminal, but it can prove the budget stops a closed stdin from being reopened
     * forever.
     *
     * @param now when the end-of-file arrived
     * @return whether to rebuild the reader rather than give up on the console
     */
    boolean worthReopening(Instant now) {
        boolean immediate = lastEndOfFile != null
                && Duration.between(lastEndOfFile, now).compareTo(END_OF_FILE_WINDOW) < 0;
        consecutiveEndOfFiles = immediate ? consecutiveEndOfFiles + 1 : 1;
        lastEndOfFile = now;
        return consecutiveEndOfFiles < END_OF_FILE_BUDGET;
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
            logger.error("Command '" + name + "' failed: " + Diagnostics.describe(e));
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
        // The sink points at a reader backed by the terminal being closed, so anything
        // logged after this would be written into a closed stream.
        output.redirectTo(System.out::println);
        if (terminal != null) {
            try {
                terminal.close();
            } catch (IOException e) {
                logger.warn("Could not close the terminal: " + Diagnostics.describe(e));
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
