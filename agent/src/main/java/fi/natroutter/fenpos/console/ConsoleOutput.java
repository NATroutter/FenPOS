package fi.natroutter.fenpos.console;

import java.util.function.Consumer;

/**
 * Where console and log output is written.
 * <p>
 * Exists so log output can be redirected once the interactive console is running. JLine
 * draws a prompt on the bottom line and expects everything else to go through
 * {@code printAbove}; without that redirection, a log line arriving while the operator is
 * typing overwrites what they have typed — which happens constantly in a daemon that logs
 * every job.
 * <p>
 * Passed explicitly rather than held statically so the sink is an ordinary dependency and
 * tests can capture it.
 */
public class ConsoleOutput {

    private volatile Consumer<String> sink = System.out::println;

    /**
     * Writes one line.
     *
     * @param line the text to write
     */
    public void println(String line) {
        sink.accept(line);
    }

    /**
     * Redirects subsequent output.
     *
     * @param replacement the new sink, typically {@code LineReader::printAbove}
     */
    public void redirectTo(Consumer<String> replacement) {
        this.sink = replacement;
    }
}
