package fi.natroutter.fenpos.http;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.TypeAdapter;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.JsonWriter;
import io.javalin.json.JsonMapper;

import java.io.IOException;
import java.lang.reflect.Type;
import java.time.Instant;
import java.time.format.DateTimeFormatter;

/**
 * Serialises responses with Gson.
 * <p>
 * Javalin has no JSON mapper of its own; it uses Jackson when that happens to be on the
 * classpath. This project already depends on Gson, so supplying a mapper explicitly keeps
 * the dependency list honest and avoids a second JSON library appearing transitively.
 * <p>
 * Null fields are omitted, which is what lets {@link ApiError} carry optional positional
 * fields without emitting misleading nulls on errors that have no position.
 */
public class GsonJsonMapper implements JsonMapper {

    private final Gson gson = new GsonBuilder()
            .registerTypeAdapter(Instant.class, new InstantAdapter())
            .disableHtmlEscaping()
            .create();

    @Override
    public String toJsonString(Object obj, Type type) {
        return gson.toJson(obj, type);
    }

    @Override
    public <T> T fromJsonString(String json, Type targetType) {
        return gson.fromJson(json, targetType);
    }

    /**
     * Writes {@link Instant} as ISO-8601 rather than as Gson's default object form.
     * <p>
     * Timestamps are part of the public job record, so they need a format a client can
     * parse without knowing anything about Java's time classes.
     */
    private static final class InstantAdapter extends TypeAdapter<Instant> {

        @Override
        public void write(JsonWriter out, Instant value) throws IOException {
            if (value == null) {
                out.nullValue();
                return;
            }
            out.value(DateTimeFormatter.ISO_INSTANT.format(value));
        }

        @Override
        public Instant read(JsonReader in) throws IOException {
            if (in.peek() == JsonToken.NULL) {
                in.nextNull();
                return null;
            }
            return Instant.parse(in.nextString());
        }
    }
}
