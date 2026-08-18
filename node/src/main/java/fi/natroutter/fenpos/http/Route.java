package fi.natroutter.fenpos.http;

import io.javalin.http.Context;
import io.javalin.http.MethodNotAllowedResponse;
import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public abstract class Route {

    private String path;

    public void get(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
    public void post(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
    public void put(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
    public void patch(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
    public void delete(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
    public void head(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
    public void options(Context ctx) {
        throw new MethodNotAllowedResponse();
    }
}
