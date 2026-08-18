package fi.natroutter.fenpos.config;

import java.util.List;
import java.util.stream.Collectors;

/**
 * Thrown when {@code config.yaml} cannot be turned into a usable runtime configuration.
 * <p>
 * Carries every problem found rather than only the first, because a half-configured
 * printer daemon that starts and then fails on the first print request is worse than one
 * that refuses to start and says exactly what to fix.
 */
public class ConfigurationException extends Exception {

    private final List<ConfigProblem> problems;

    /**
     * Creates an exception reporting the given problems.
     *
     * @param problems the defects found; must not be empty
     * @throws IllegalArgumentException if {@code problems} is empty
     */
    public ConfigurationException(List<ConfigProblem> problems) {
        super(buildMessage(problems));
        if (problems.isEmpty()) {
            throw new IllegalArgumentException("ConfigurationException requires at least one problem");
        }
        this.problems = List.copyOf(problems);
    }

    /** Returns every problem found, in the order they were detected. */
    public List<ConfigProblem> problems() {
        return problems;
    }

    private static String buildMessage(List<ConfigProblem> problems) {
        return problems.size() + " configuration problem(s):"
                + problems.stream().map(problem -> System.lineSeparator() + "  - " + problem)
                        .collect(Collectors.joining());
    }
}
