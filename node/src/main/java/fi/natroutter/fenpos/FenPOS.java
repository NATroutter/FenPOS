package fi.natroutter.fenpos;

import fi.natroutter.foxlib.FoxLib;
import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.config.ConfigProvider;
import fi.natroutter.fenpos.config.ConfigurationException;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.console.ConsoleManager;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.console.commands.CancelCommand;
import fi.natroutter.fenpos.console.commands.CheckConfigCommand;
import fi.natroutter.fenpos.console.commands.ClearCommand;
import fi.natroutter.fenpos.console.commands.ConnectCommand;
import fi.natroutter.fenpos.console.commands.DevicesCommand;
import fi.natroutter.fenpos.console.commands.DisconnectCommand;
import fi.natroutter.fenpos.console.commands.HelpCommand;
import fi.natroutter.fenpos.console.commands.JobCommand;
import fi.natroutter.fenpos.console.commands.JobsCommand;
import fi.natroutter.fenpos.console.commands.KeygenCommand;
import fi.natroutter.fenpos.console.commands.PauseCommand;
import fi.natroutter.fenpos.console.commands.PrintCommand;
import fi.natroutter.fenpos.console.commands.RawCommand;
import fi.natroutter.fenpos.console.commands.ResumeCommand;
import fi.natroutter.fenpos.console.commands.ScanCommand;
import fi.natroutter.fenpos.console.commands.StatusCommand;
import fi.natroutter.fenpos.console.commands.StopCommand;
import fi.natroutter.fenpos.console.commands.TestCommand;
import fi.natroutter.fenpos.console.commands.VersionCommand;
import fi.natroutter.fenpos.http.DeviceAuthenticator;
import fi.natroutter.fenpos.http.HttpServer;
import fi.natroutter.fenpos.http.endpoints.DeviceStatus;
import fi.natroutter.fenpos.http.endpoints.Jobs;
import fi.natroutter.fenpos.http.endpoints.Print;
import fi.natroutter.fenpos.http.endpoints.Status;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import lombok.Getter;

import java.io.IOException;
import java.io.InputStream;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Properties;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Entry point and process lifecycle.
 * <p>
 * Components are constructed in dependency order and shut down in the reverse: stop
 * accepting new work, settle what is outstanding, then release the hardware. Shutdown runs
 * from a single JVM hook rather than from individual components, so it happens once and in
 * a defined order.
 */
public class FenPOS extends FoxLib {

    /** How often expired job records are swept. */
    private static final Duration EVICTION_INTERVAL = Duration.ofMinutes(1);

    @Getter
    private static String VERSION;

    static {
        Properties props = new Properties();
        try (InputStream is = FenPOS.class.getResourceAsStream("/build.properties")) {
            if (is != null) {
                props.load(is);
            }
        } catch (IOException ignored) {
            // Version is cosmetic; a missing build.properties must not stop the daemon.
        }
        VERSION = props.getProperty("version", "unknown");
    }

    @Getter
    private static ConfigProvider configProvider;

    @Getter
    private static FoxLogger logger;

    @Getter
    private static HttpServer httpServer;

    @Getter
    private static PrintService printService;

    @Getter
    private static DeviceConnectionManager connections;

    private static ScheduledExecutorService janitor;
    private static ConsoleOutput consoleOutput;
    private static ConsoleManager console;
    private static Duration shutdownGrace = Duration.ofSeconds(10);
    private static volatile boolean shuttingDown;

    public static void main(String[] args) {
        // Log output goes through the console sink so that, once the interactive console
        // is running, JLine can draw log lines above the prompt instead of over whatever
        // the operator is typing.
        consoleOutput = new ConsoleOutput();
        logger = new FoxLogger.Builder()
                .setDebug(false)
                .setPruneOlderThanDays(35)
                .setSaveIntervalSeconds(300)
                .setLoggerName("ThermAPI")
                .setPrintter(consoleOutput::println)
                .build();

        printBanner();

        if (!loadConfiguration()) {
            return;
        }
        ResolvedConfig config = configProvider.get();
        shutdownGrace = config.jobs().shutdownGrace();

        Instant startedAt = Instant.now();

        connections = new DeviceConnectionManager(config, logger);
        printService = new PrintService(config, connections::port, Clock.systemUTC(), logger);
        DeviceAuthenticator authenticator = new DeviceAuthenticator(config);

        connections.connectAutoStartDevices();
        printService.start();
        startJanitor();

        httpServer = new HttpServer(config, logger);
        httpServer.register(
                new Status(Instant.now()),
                new DeviceStatus(printService, connections, authenticator),
                new Print(printService, authenticator),
                new Jobs(printService, authenticator));

        Runtime.getRuntime().addShutdownHook(new Thread(FenPOS::shutdown, "thermapi-shutdown"));

        try {
            httpServer.start();
        } catch (IllegalStateException e) {
            logger.error("Could not start the HTTP server: " + e.getMessage());
            shutdown();
            return;
        }

        // Started last so its prompt appears once the startup log has settled.
        startConsole(config, startedAt);
    }

    /** Builds and starts the console, if this process has a terminal to run one on. */
    private static void startConsole(ResolvedConfig config, Instant startedAt) {
        console = new ConsoleManager(consoleOutput, logger);
        console.register(
                new HelpCommand(consoleOutput, console),
                new VersionCommand(consoleOutput),
                new StatusCommand(consoleOutput, printService, startedAt),
                new ScanCommand(consoleOutput),
                new DevicesCommand(consoleOutput, printService, connections),
                new ConnectCommand(consoleOutput, printService, connections),
                new DisconnectCommand(consoleOutput, printService, connections),
                new CheckConfigCommand(consoleOutput, configProvider, config),
                new JobsCommand(consoleOutput, printService),
                new JobCommand(consoleOutput, printService),
                new CancelCommand(consoleOutput, printService),
                new PauseCommand(consoleOutput, printService),
                new ResumeCommand(consoleOutput, printService),
                new ClearCommand(consoleOutput, printService),
                new TestCommand(consoleOutput, printService),
                new PrintCommand(consoleOutput, printService),
                new RawCommand(consoleOutput, printService, connections),
                new KeygenCommand(consoleOutput),
                new StopCommand(consoleOutput, FenPOS::shutdown));

        if (console.start()) {
            logger.info("Console ready; type 'help' for commands");
        }
    }

    /**
     * Loads and validates configuration, reporting every problem before giving up.
     *
     * @return whether startup may continue
     */
    private static boolean loadConfiguration() {
        try {
            configProvider = new ConfigProvider(logger);
            return true;
        } catch (ConfigurationException e) {
            logger.error("Configuration is unusable, refusing to start:");
            e.problems().forEach(problem -> logger.error("  - " + problem));
            return false;
        }
    }

    /** Starts the background sweep that discards job records past their retention. */
    private static void startJanitor() {
        janitor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "thermapi-job-janitor");
            thread.setDaemon(true);
            return thread;
        });
        janitor.scheduleAtFixedRate(
                () -> {
                    try {
                        printService.evictExpiredJobs();
                    } catch (RuntimeException e) {
                        // A sweep failure must not kill the scheduled task, which would
                        // silently stop all future eviction and leak job records.
                        logger.error("Job eviction failed", e);
                    }
                },
                EVICTION_INTERVAL.toSeconds(),
                EVICTION_INTERVAL.toSeconds(),
                TimeUnit.SECONDS);
    }

    /**
     * Stops the daemon in dependency order.
     * <p>
     * The HTTP listener goes first so no further work arrives, then queues settle what is
     * outstanding, and only then are the serial ports released. Guarded so a manual
     * {@code stop} followed by the JVM hook does not run it twice.
     */
    public static synchronized void shutdown() {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info("Shutting down...");

        if (console != null) {
            console.stop();
        }
        if (httpServer != null) {
            httpServer.stop();
        }
        if (janitor != null) {
            janitor.shutdownNow();
        }
        if (printService != null) {
            printService.shutdown(shutdownGrace);
        }
        if (connections != null) {
            connections.shutdown();
        }
        logger.info("Goodbye");
    }

    private static void printBanner() {
        println("[35m _____ _                       _   ____ ___ ");
        println("[35m|_   _| |__   ___ _ __ _ __ ___ / \\ |  _ \\_ _|");
        println("[35m  | | | '_ \\ / _ \\ '__| '_ ` _ \\/ _ \\| |_) | | ");
        println("[35m  | | | | | |  __/ |  | | | | | / ___ \\  __/| | ");
        println("[35m  |_| |_| |_|\\___|_|  |_| |_| |_/_/   \\_\\_|  |___|");
        println("[35m• Version: " + VERSION);
        println("[35m• Author: NATroutter");
        println("[35m• Website: https://NATroutter.fi");
        println(" ");
    }
}
