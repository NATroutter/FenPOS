package fi.natroutter.fenpos.console;

import org.jline.reader.Candidate;
import org.jline.reader.Completer;
import org.jline.reader.LineReader;
import org.jline.reader.ParsedLine;

import java.util.List;
import java.util.Objects;

/**
 * Supplies tab-completion from the registered commands.
 * <p>
 * Candidates come from {@link Command#complete(String[])}, so a command that knows its own
 * valid arguments — device names, live job identifiers — offers them without the console
 * needing to know anything about it.
 */
public class CommandCompleter implements Completer {

    private final ConsoleManager console;

    /**
     * @param console the registry to complete against
     */
    public CommandCompleter(ConsoleManager console) {
        this.console = Objects.requireNonNull(console, "console");
    }

    @Override
    public void complete(LineReader reader, ParsedLine line, List<Candidate> candidates) {
        List<String> matches = console.completionsFor(line.words(), line.wordIndex());
        matches.forEach(match -> candidates.add(new Candidate(match)));
    }
}
