package fi.natroutter.fenpos.config;

import fi.natroutter.fenpos.config.data.Config;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.Constructor;
import org.yaml.snakeyaml.error.YAMLException;
import org.yaml.snakeyaml.introspector.PropertyUtils;

import java.util.List;

/**
 * Binds {@code config.yaml} text to the {@link Config} object graph.
 * <p>
 * Kept separate from {@link ConfigProvider} so the mapping can be exercised against literal
 * YAML in tests without touching the filesystem.
 */
public final class ConfigParser {

    /**
     * Upper bound on document size. The configuration file is operator-supplied rather than
     * attacker-supplied, but an accidental multi-gigabyte file should fail with a clear
     * message instead of exhausting the heap.
     */
    private static final int MAX_DOCUMENT_CODE_POINTS = 1024 * 1024;

    private ConfigParser() {
    }

    /**
     * Parses YAML into the raw configuration model.
     * <p>
     * Unknown keys are ignored rather than fatal, so a file written for a newer version
     * still starts an older binary. Unknown <em>values</em> are not tolerated: those are
     * caught by {@link ConfigResolver} where they can be reported with a path.
     *
     * @param yaml the file contents
     * @return the bound configuration; never {@code null}
     * @throws ConfigurationException if the document is empty or not valid YAML
     */
    public static Config parse(String yaml) throws ConfigurationException {
        if (yaml == null || yaml.isBlank()) {
            throw new ConfigurationException(List.of(
                    new ConfigProblem("config.yaml", "File is empty")));
        }

        try {
            Config config = newYaml().loadAs(yaml, Config.class);
            if (config == null) {
                throw new ConfigurationException(List.of(
                        new ConfigProblem("config.yaml", "File contains no configuration")));
            }
            return config;
        } catch (YAMLException e) {
            throw new ConfigurationException(List.of(
                    new ConfigProblem("config.yaml", "Not valid YAML: " + e.getMessage())));
        }
    }

    /**
     * Builds a YAML reader bound to {@link Config}.
     * <p>
     * The typed {@link Constructor} is used rather than a generic one so the document can
     * only ever produce {@code Config} and its nested types; a plain {@code Yaml} instance
     * would let the file name arbitrary classes to instantiate.
     */
    private static Yaml newYaml() {
        LoaderOptions options = new LoaderOptions();
        options.setCodePointLimit(MAX_DOCUMENT_CODE_POINTS);
        options.setAllowDuplicateKeys(false);

        // PropertyUtils must be set explicitly rather than mutated via getPropertyUtils():
        // SnakeYAML only propagates it to nested bean descriptions when it was supplied by
        // the caller, so mutating the lazily created instance leaves nested types strict.
        PropertyUtils propertyUtils = new PropertyUtils();
        propertyUtils.setSkipMissingProperties(true);

        Constructor constructor = new Constructor(Config.class, options);
        constructor.setPropertyUtils(propertyUtils);
        return new Yaml(constructor);
    }
}
