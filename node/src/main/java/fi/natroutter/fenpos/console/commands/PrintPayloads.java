package fi.natroutter.fenpos.console.commands;

import com.google.gson.Gson;

import java.util.List;

/**
 * Builds request bodies for console commands that print.
 * <p>
 * Console commands go through the same compile pipeline as HTTP requests, which means
 * handing it JSON. Assembling that with string concatenation would break the moment a
 * receipt contained a quote or a backslash, so it is delegated to the JSON library.
 */
final class PrintPayloads {

    private static final Gson GSON = new Gson();

    private PrintPayloads() {
    }

    /**
     * Escapes text as a JSON string literal, quotes included.
     *
     * @param text the raw text
     */
    static String jsonString(String text) {
        return GSON.toJson(text);
    }

    /**
     * Builds a request body from a list of lines.
     *
     * @param lines the {@code data} elements
     */
    static String body(List<String> lines) {
        return "{\"data\":" + GSON.toJson(lines) + "}";
    }
}
