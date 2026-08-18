package fi.natroutter.fenpos.config;

/**
 * A single configuration defect, identified by where it occurs rather than only by what is
 * wrong, so an operator can find the offending line without searching the file.
 *
 * @param path    dotted path into {@code config.yaml}, such as {@code devices.kitchen.port}
 * @param message what is wrong, phrased for someone editing the file
 */
public record ConfigProblem(String path, String message) {

    @Override
    public String toString() {
        return path + ": " + message;
    }
}
