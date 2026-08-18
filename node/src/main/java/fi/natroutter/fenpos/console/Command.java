package fi.natroutter.fenpos.console;

import java.util.List;

/**
 * One console command.
 * <p>
 * Adding a command is one class implementing this interface plus one registration, and
 * nothing else: the registry derives help text, tab-completion and dispatch from what is
 * declared here, so there is no second place to keep in step.
 * <p>
 * Implementations receive whatever they operate on through their constructor, which keeps
 * {@link #execute(String[])} free of service lookups and makes each command testable on its
 * own.
 */
public interface Command {

    /** Returns the primary name typed to invoke this command. Must be lowercase. */
    String name();

    /** Returns alternative names accepted for this command. */
    default List<String> aliases() {
        return List.of();
    }

    /** Returns a one-line description shown by {@code help}. */
    String description();

    /** Returns the argument syntax, shown by {@code help <command>}. */
    default String usage() {
        return name();
    }

    /**
     * Returns completion candidates for the argument currently being typed.
     *
     * @param args arguments typed so far, excluding the command name
     * @return candidate values for the next argument; empty when there is nothing to suggest
     */
    default List<String> complete(String[] args) {
        return List.of();
    }

    /**
     * Runs the command.
     * <p>
     * Implementations report problems by writing to their output rather than throwing:
     * a mistyped argument is ordinary console use, not an exceptional condition.
     *
     * @param args arguments, excluding the command name
     */
    void execute(String[] args);
}
