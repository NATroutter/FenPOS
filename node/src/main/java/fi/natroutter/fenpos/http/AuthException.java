package fi.natroutter.fenpos.http;

/**
 * Thrown when a request cannot be authorised for the device it names.
 * <p>
 * The status and code deliberately do not distinguish "this key is wrong" from "this device
 * does not exist" in the way a naive implementation would; see
 * {@link DeviceAuthenticator} for why.
 */
public class AuthException extends Exception {

    private final String apiCode;
    private final int status;

    /**
     * @param apiCode stable code for the response's {@code error} field
     * @param status  HTTP status to return
     * @param message human-readable explanation
     */
    public AuthException(String apiCode, int status, String message) {
        super(message);
        this.apiCode = apiCode;
        this.status = status;
    }

    /** Returns the stable code for the response's {@code error} field. */
    public String apiCode() {
        return apiCode;
    }

    /** Returns the HTTP status to respond with. */
    public int status() {
        return status;
    }
}
