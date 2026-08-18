package fi.natroutter.fenpos.console;

import fi.natroutter.foxlib.logger.FoxLogger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link ConsoleManager}'s registry and dispatch.
 * <p>
 * Dispatch is tested directly rather than through the read loop, which needs a terminal.
 * That split is deliberate: parsing and routing are where the logic is, and they should not
 * require a TTY to verify.
 */
class ConsoleManagerTest {

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final List<String> printed = new ArrayList<>();
    private final ConsoleOutput output = new ConsoleOutput();

    private ConsoleManager console;

    @BeforeEach
    void setUp() {
        output.redirectTo(printed::add);
        console = new ConsoleManager(output, logger);
    }

    @Test
    void dispatchesToTheNamedCommand() {
        RecordingCommand command = new RecordingCommand("greet");
        console.register(command);

        console.dispatch("greet");

        assertEquals(1, command.invocations.size());
    }

    @Test
    void passesArgumentsWithoutTheCommandName() {
        RecordingCommand command = new RecordingCommand("greet");
        console.register(command);

        console.dispatch("greet alpha beta");

        assertEquals(List.of("alpha", "beta"), List.of(command.invocations.getFirst()));
    }

    @Test
    void collapsesRepeatedWhitespaceBetweenArguments() {
        RecordingCommand command = new RecordingCommand("greet");
        console.register(command);

        console.dispatch("   greet    alpha     beta   ");

        assertEquals(List.of("alpha", "beta"), List.of(command.invocations.getFirst()));
    }

    @Test
    void dispatchesByAlias() {
        RecordingCommand command = new RecordingCommand("greet", List.of("hi"));
        console.register(command);

        console.dispatch("hi");

        assertEquals(1, command.invocations.size());
    }

    @Test
    void isCaseInsensitive() {
        RecordingCommand command = new RecordingCommand("greet");
        console.register(command);

        console.dispatch("GREET");

        assertEquals(1, command.invocations.size());
    }

    @Test
    void ignoresBlankInput() {
        console.dispatch("   ");
        console.dispatch("");

        assertTrue(printed.isEmpty());
    }

    @Test
    void suggestsTheClosestNameForATypo() {
        console.register(new RecordingCommand("devices"));

        console.dispatch("devcies");

        assertEquals(1, printed.size());
        assertTrue(printed.getFirst().contains("Did you mean 'devices'"),
                () -> "expected a suggestion, got: " + printed.getFirst());
    }

    @Test
    void offersNoSuggestionForSomethingEntirelyUnlike() {
        console.register(new RecordingCommand("devices"));

        console.dispatch("xyzzyplughfoo");

        assertTrue(printed.getFirst().startsWith("Unknown command"));
        assertTrue(printed.getFirst().contains("Did you mean") == false,
                () -> "should not guess wildly, got: " + printed.getFirst());
    }

    /**
     * A command that throws must not take the console down; an operator needs the prompt
     * back more than they need the process dead.
     */
    @Test
    void survivesACommandThatThrows() {
        console.register(new ThrowingCommand());

        console.dispatch("boom");

        assertTrue(printed.getFirst().startsWith("Command failed"));
    }

    /**
     * Silently letting one command shadow another would make dispatch depend on
     * registration order, which is invisible at the call site.
     */
    @Test
    void rejectsTwoCommandsClaimingTheSameName() {
        console.register(new RecordingCommand("greet"));

        assertThrows(IllegalStateException.class,
                () -> console.register(new RecordingCommand("greet")));
    }

    @Test
    void rejectsAnAliasThatCollidesWithAnExistingName() {
        console.register(new RecordingCommand("greet"));

        assertThrows(IllegalStateException.class,
                () -> console.register(new RecordingCommand("wave", List.of("greet"))));
    }

    @Test
    void listsEachCommandOnceDespiteAliases() {
        console.register(new RecordingCommand("greet", List.of("hi", "hello")));

        assertEquals(1, console.commands().size());
    }

    @Test
    void completesCommandNamesAtTheStartOfALine() {
        console.register(new RecordingCommand("greet"), new RecordingCommand("goodbye"));

        List<String> candidates = console.completionsFor(List.of(""), 0);

        assertTrue(candidates.contains("greet"));
        assertTrue(candidates.contains("goodbye"));
    }

    @Test
    void delegatesArgumentCompletionToTheCommand() {
        console.register(new RecordingCommand("greet") {
            @Override
            public List<String> complete(String[] args) {
                return List.of("alpha", "beta");
            }
        });

        assertEquals(List.of("alpha", "beta"),
                console.completionsFor(List.of("greet", ""), 1));
    }

    /** Records what it was invoked with, so dispatch can be asserted. */
    private static class RecordingCommand implements Command {

        private final String name;
        private final List<String> aliases;
        private final List<String[]> invocations = new ArrayList<>();

        RecordingCommand(String name) {
            this(name, List.of());
        }

        RecordingCommand(String name, List<String> aliases) {
            this.name = name;
            this.aliases = aliases;
        }

        @Override
        public String name() {
            return name;
        }

        @Override
        public List<String> aliases() {
            return aliases;
        }

        @Override
        public String description() {
            return "test command";
        }

        @Override
        public void execute(String[] args) {
            invocations.add(args);
        }
    }

    /** Fails on purpose, to prove the console survives it. */
    private static class ThrowingCommand implements Command {

        @Override
        public String name() {
            return "boom";
        }

        @Override
        public String description() {
            return "always fails";
        }

        @Override
        public void execute(String[] args) {
            throw new IllegalStateException("deliberate");
        }
    }
}
