package fi.natroutter.fenpos.config;

import fi.natroutter.fenpos.config.data.Config;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for {@link ConfigParser}, including a guard that the template shipped in resources
 * stays loadable as the configuration model evolves.
 */
class ConfigParserTest {

    @Test
    void parsesShippedTemplate() throws Exception {
        Config config = ConfigParser.parse(readShippedTemplate());

        assertNotNull(config.getHttpServer());
        assertEquals(8080, config.getHttpServer().getPort());
        assertEquals(42, config.getDevices().get("kitchen").getColumns());
        assertEquals("CP858", config.getDevices().get("kitchen").getCodepage());
    }

    /**
     * The template must not ship a usable credential: a key committed to the repository
     * would be a known secret on every default install. Startup is expected to fail until
     * an operator generates one.
     */
    @Test
    void shippedTemplateRefusesToResolveUntilAnAuthKeyIsSet() throws Exception {
        Config config = ConfigParser.parse(readShippedTemplate());

        ConfigurationException thrown = assertThrows(
                ConfigurationException.class, () -> ConfigResolver.resolve(config));

        assertTrue(thrown.problems().stream()
                        .anyMatch(problem -> problem.path().equals("devices.kitchen.authKey")),
                () -> "expected the template to demand an authKey, got " + thrown.problems());
    }

    @Test
    void rejectsMalformedYaml() {
        assertThrows(ConfigurationException.class, () -> ConfigParser.parse("httpServer: [unclosed"));
    }

    @Test
    void rejectsEmptyDocument() {
        assertThrows(ConfigurationException.class, () -> ConfigParser.parse("   "));
    }

    /**
     * An unknown key is tolerated rather than fatal, so a config written for a newer
     * version still starts an older binary instead of bricking it.
     */
    @Test
    void ignoresUnknownKeys() throws Exception {
        Config config = ConfigParser.parse("""
                httpServer:
                  port: 9090
                  somethingFromTheFuture: true
                """);

        assertEquals(9090, config.getHttpServer().getPort());
    }

    private static String readShippedTemplate() throws Exception {
        try (InputStream stream = ConfigParserTest.class.getResourceAsStream("/config.yaml")) {
            assertNotNull(stream, "config.yaml is missing from resources");
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
