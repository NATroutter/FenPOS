package fi.natroutter.fenpos;

import fi.natroutter.foxlib.FoxLib;
import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.console.ConsoleManager;
import fi.natroutter.fenpos.console.ConsoleOutput;
import fi.natroutter.fenpos.console.commands.CancelCommand;
import fi.natroutter.fenpos.console.commands.ClearCommand;
import fi.natroutter.fenpos.console.commands.ConnectCommand;
import fi.natroutter.fenpos.console.commands.DevicesCommand;
import fi.natroutter.fenpos.console.commands.DisconnectCommand;
import fi.natroutter.fenpos.console.commands.HelpCommand;
import fi.natroutter.fenpos.console.commands.JobCommand;
import fi.natroutter.fenpos.console.commands.JobsCommand;
import fi.natroutter.fenpos.console.commands.LinkCommand;
import fi.natroutter.fenpos.console.commands.PairCommand;
import fi.natroutter.fenpos.console.commands.PauseCommand;
import fi.natroutter.fenpos.console.commands.PrintCommand;
import fi.natroutter.fenpos.console.commands.RawCommand;
import fi.natroutter.fenpos.console.commands.ResumeCommand;
import fi.natroutter.fenpos.console.commands.ScanCommand;
import fi.natroutter.fenpos.console.commands.StatusCommand;
import fi.natroutter.fenpos.console.commands.StopCommand;
import fi.natroutter.fenpos.console.commands.TestCommand;
import fi.natroutter.fenpos.console.commands.UnpairCommand;
import fi.natroutter.fenpos.console.commands.VersionCommand;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.link.AgentInfo;
import fi.natroutter.fenpos.link.Frames;
import fi.natroutter.fenpos.link.LinkClient;
import fi.natroutter.fenpos.link.LinkDispatcher;
import fi.natroutter.fenpos.pair.EnvironmentPairing;
import fi.natroutter.fenpos.pair.PairingClient;
import fi.natroutter.fenpos.pair.PairingService;
import fi.natroutter.fenpos.print.JobSettings;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import fi.natroutter.fenpos.store.AgentStore;
import fi.natroutter.fenpos.store.StoreException;
import lombok.Getter;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
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
 * <p>
 * The agent starts knowing nothing but its own identity. There is no configuration file: the
 * device set arrives from the server over the link, so the process comes up with no printers
 * and acquires them when the first {@code config.sync} lands. Starting an agent that has never
 * been paired is therefore normal, not an error — it idles with an empty device set until
 * someone pairs it, which is the only behaviour that makes sense in a container that would
 * otherwise restart-loop with the reason buried in the logs.
 */
public class FenPOSAgent extends FoxLib {

    /** How often expired job records are swept. */
    private static final Duration EVICTION_INTERVAL = Duration.ofMinutes(1);

    /**
     * How often device state is pushed even when nothing changed.
     * <p>
     * A backstop, not the main channel: every state change reports itself immediately. This
     * catches the ones nothing observes, chiefly a background reconnect finding its printer
     * again, which would otherwise show as offline in the panel until someone touched it.
     */
    private static final Duration STATUS_INTERVAL = Duration.ofSeconds(30);

    /** Where the local store lives, relative to the working directory. */
    private static final Path STORE_FILE = Path.of("data", "agent.db");

    @Getter
    private static String VERSION;

    static {
        Properties props = new Properties();
        try (InputStream is = FenPOSAgent.class.getResourceAsStream("/build.properties")) {
            if (is != null) {
                props.load(is);
            }
        } catch (IOException ignored) {
            // Version is cosmetic; a missing build.properties must not stop the agent.
        }
        VERSION = props.getProperty("version", "unknown");
    }

    @Getter
    private static FoxLogger logger;

    @Getter
    private static AgentStore store;

    @Getter
    private static DeviceRegistry devices;

    @Getter
    private static PrintService printService;

    @Getter
    private static DeviceConnectionManager connections;

    @Getter
    private static PairingService pairing;

    @Getter
    private static LinkClient link;

    private static ScheduledExecutorService janitor;
    private static ConsoleOutput consoleOutput;
    private static ConsoleManager console;
    private static Duration shutdownGrace = JobSettings.DEFAULTS.shutdownGrace();
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
                .setLoggerName("FenPOS")
                .setPrintter(consoleOutput::println)
                .build();

        printBanner();

        if (!openStore()) {
            return;
        }

        Instant startedAt = Instant.now();
        JobSettings jobSettings = JobSettings.DEFAULTS;
        shutdownGrace = jobSettings.shutdownGrace();

        devices = new DeviceRegistry();
        connections = new DeviceConnectionManager(devices, logger);
        printService = new PrintService(
                devices, jobSettings, connections::port, Clock.systemUTC(), logger);

        printService.start();
        startJanitor();

        AgentInfo info = AgentInfo.of(VERSION);
        pairing = new PairingService(store, new PairingClient(), info);

        LinkDispatcher dispatcher =
                new LinkDispatcher(devices, printService, connections, FenPOSAgent::applyConfig, logger);
        link = new LinkClient(info, dispatcher, logger);
        dispatcher.attach(link::send);
        startStatusReports(dispatcher);

        Runtime.getRuntime().addShutdownHook(new Thread(FenPOSAgent::shutdown, "fenpos-agent-shutdown"));

        // Pairing before the console starts, so an operator watching a container's logs sees the
        // outcome rather than a prompt they cannot type at.
        new EnvironmentPairing(pairing, logger).resolve().ifPresent(link::start);

        // Started last so its prompt appears once the startup log has settled.
        startConsole(startedAt);
    }

    /**
     * Adopts a device set the server pushed.
     * <p>
     * The single entry point for {@code config.sync}, so the two layers that care are always
     * updated together and in the right order: the serial layer first, because a print queue
     * is built around the port that layer owns.
     *
     * @param wire the devices as the server described them
     */
    public static synchronized void applyConfig(List<Frames.DeviceConfig> wire) {
        if (shuttingDown) {
            return;
        }
        devices.apply(wire);
        connections.applyDevices();
        printService.applyDevices();
        logger.info("Configuration applied: " + devices.size() + " device(s)");
    }

    /**
     * Opens the local store, which holds this agent's identity.
     *
     * @return whether startup may continue
     */
    private static boolean openStore() {
        try {
            store = AgentStore.open(STORE_FILE);
            return true;
        } catch (StoreException e) {
            // Without the store the agent cannot know who it is paired to, and pairing again
            // would not survive a restart. Starting anyway would look like it worked.
            logger.error("Local store is unusable, refusing to start: " + e.getMessage());
            return false;
        }
    }

    /** Builds and starts the console, if this process has a terminal to run one on. */
    private static void startConsole(Instant startedAt) {
        console = new ConsoleManager(consoleOutput, logger);
        console.register(
                new HelpCommand(consoleOutput, console),
                new VersionCommand(consoleOutput),
                new StatusCommand(consoleOutput, printService, store, startedAt),
                new LinkCommand(consoleOutput, link),
                new PairCommand(consoleOutput, pairing, link),
                new UnpairCommand(consoleOutput, pairing, link, FenPOSAgent::applyConfig),
                new ScanCommand(consoleOutput),
                new DevicesCommand(consoleOutput, printService, connections),
                new ConnectCommand(consoleOutput, printService, connections),
                new DisconnectCommand(consoleOutput, printService, connections),
                new JobsCommand(consoleOutput, printService),
                new JobCommand(consoleOutput, printService),
                new CancelCommand(consoleOutput, printService),
                new PauseCommand(consoleOutput, printService),
                new ResumeCommand(consoleOutput, printService),
                new ClearCommand(consoleOutput, printService),
                new TestCommand(consoleOutput, printService),
                new PrintCommand(consoleOutput, printService),
                new RawCommand(consoleOutput, printService, connections),
                new StopCommand(consoleOutput, FenPOSAgent::shutdown));

        if (console.start()) {
            logger.info("Console ready; type 'help' for commands");
        }
    }

    /** Starts the slow backstop that pushes device state when nothing else has. */
    private static void startStatusReports(LinkDispatcher dispatcher) {
        janitor.scheduleAtFixedRate(
                () -> {
                    try {
                        dispatcher.reportStatus();
                    } catch (RuntimeException e) {
                        // A failed report must not kill the scheduled task, which would stop all
                        // future reports and leave the panel frozen on the last one.
                        logger.error("Status report failed", e);
                    }
                },
                STATUS_INTERVAL.toSeconds(),
                STATUS_INTERVAL.toSeconds(),
                TimeUnit.SECONDS);
    }

    /** Starts the background sweep that discards job records past their retention. */
    private static void startJanitor() {
        janitor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "fenpos-agent-job-janitor");
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
     * Stops the agent in dependency order.
     * <p>
     * Queues settle what is outstanding, then the serial ports are released, and the store
     * closes last so a job update written during the drain still lands. Guarded so a manual
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
        if (janitor != null) {
            janitor.shutdownNow();
        }
        if (link != null) {
            link.shutdown();
        }
        if (printService != null) {
            printService.shutdown(shutdownGrace);
        }
        if (connections != null) {
            connections.shutdown();
        }
        if (store != null) {
            store.close();
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
