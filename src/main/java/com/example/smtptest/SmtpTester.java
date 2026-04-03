package com.example.smtptest;

import jakarta.mail.Authenticator;
import jakarta.mail.Message;
import jakarta.mail.MessagingException;
import jakarta.mail.PasswordAuthentication;
import jakarta.mail.Session;
import jakarta.mail.Transport;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Properties;
import java.util.Set;
import java.util.stream.Collectors;

public class SmtpTester {
    public static void main(String[] args) {
        try {
            CliOptions options = CliOptions.parse(args);

            if (options.hasFlag("help") || args.length == 0) {
                printUsage();
                return;
            }

            String host = options.require("host");
            boolean ssl = options.hasFlag("ssl");
            boolean startTls = options.hasFlag("starttls");
            int defaultPort = ssl ? 465 : 587;
            int port = options.getInt("port", defaultPort);
            int timeoutMs = options.getInt("timeout", 10000);
            boolean debug = options.hasFlag("debug");

            String username = options.get("username");
            String password = firstNonBlank(options.get("password"), System.getenv("SMTP_PASSWORD"));
            boolean auth = options.hasFlag("auth") || (username != null && !username.isBlank());

            Properties props = new Properties();
            props.put("mail.smtp.host", host);
            props.put("mail.smtp.port", String.valueOf(port));
            props.put("mail.smtp.connectiontimeout", String.valueOf(timeoutMs));
            props.put("mail.smtp.timeout", String.valueOf(timeoutMs));
            props.put("mail.smtp.writetimeout", String.valueOf(timeoutMs));
            props.put("mail.smtp.auth", String.valueOf(auth));
            props.put("mail.smtp.starttls.enable", String.valueOf(startTls));
            props.put("mail.smtp.ssl.enable", String.valueOf(ssl));

            if (options.hasFlag("trust-all")) {
                props.put("mail.smtp.ssl.trust", "*");
                props.put("mail.smtp.ssl.checkserveridentity", "false");
            }

            if (auth && (isBlank(username) || isBlank(password))) {
                throw new IllegalArgumentException("Authentication enabled, but username/password are missing. Use --username and --password (or SMTP_PASSWORD env var).");
            }

            Authenticator authenticator = null;
            if (auth) {
                authenticator = new Authenticator() {
                    @Override
                    protected PasswordAuthentication getPasswordAuthentication() {
                        return new PasswordAuthentication(username, password);
                    }
                };
            }

            Session session = Session.getInstance(props, authenticator);
            session.setDebug(debug);

            if (options.hasFlag("check-only")) {
                runConnectionCheck(session, host, port, auth, username, password);
                return;
            }

            sendTestMessage(session, host, port, auth, username, password, options);
        } catch (Exception ex) {
            System.err.println("ERROR: " + ex.getMessage());
            if (ex instanceof MessagingException messagingException) {
                Exception next = messagingException.getNextException();
                if (next != null) {
                    System.err.println("CAUSE: " + next.getMessage());
                }
            }
            System.exit(1);
        }
    }

    private static void runConnectionCheck(
            Session session,
            String host,
            int port,
            boolean auth,
            String username,
            String password
    ) throws MessagingException {
        try (Transport transport = session.getTransport("smtp")) {
            if (auth) {
                transport.connect(host, port, username, password);
            } else {
                transport.connect();
            }
            System.out.println("SMTP connection successful.");
        }
    }

    private static void sendTestMessage(
            Session session,
            String host,
            int port,
            boolean auth,
            String username,
            String password,
            CliOptions options
    ) throws MessagingException, IOException {
        String from = options.require("from");
        String to = options.require("to");
        String subject = options.getOrDefault("subject", "SMTP Test Message");
        String body = options.get("body");
        String bodyFile = options.get("body-file");

        if (isBlank(body) && !isBlank(bodyFile)) {
            body = Files.readString(Path.of(bodyFile));
        }
        if (isBlank(body)) {
            body = "This is an SMTP test message.";
        }

        MimeMessage message = new MimeMessage(session);
        message.setFrom(new InternetAddress(from));

        InternetAddress[] recipients = Arrays.stream(to.split(","))
                .map(String::trim)
                .filter(s -> !s.isBlank())
                .map(address -> {
                    try {
                        return new InternetAddress(address);
                    } catch (MessagingException e) {
                        throw new IllegalArgumentException("Invalid recipient address: " + address, e);
                    }
                })
                .toArray(InternetAddress[]::new);

        if (recipients.length == 0) {
            throw new IllegalArgumentException("No valid recipients provided in --to");
        }

        message.setRecipients(Message.RecipientType.TO, recipients);
        message.setSubject(subject, "UTF-8");
        message.setText(body, "UTF-8");

        if (auth) {
            try (Transport transport = session.getTransport("smtp")) {
                transport.connect(host, port, username, password);
                transport.sendMessage(message, message.getAllRecipients());
            }
        } else {
            Transport.send(message);
        }

        System.out.println("Test email sent successfully.");
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (!isBlank(value)) {
                return value;
            }
        }
        return null;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static void printUsage() {
        System.out.println("SMTP Tester (Java)");
        System.out.println();
        System.out.println("Required:");
        System.out.println("  --host <smtp-host>");
        System.out.println();
        System.out.println("Connection options:");
        System.out.println("  --port <number>         SMTP port (default: 587, or 465 with --ssl)");
        System.out.println("  --starttls              Enable STARTTLS");
        System.out.println("  --ssl                   Enable SMTPS (implicit TLS)");
        System.out.println("  --timeout <ms>          Socket timeouts in milliseconds (default: 10000)");
        System.out.println("  --auth                  Force authentication");
        System.out.println("  --username <user>");
        System.out.println("  --password <pass>       Or use SMTP_PASSWORD environment variable");
        System.out.println("  --trust-all             Trust any TLS certificate (testing only)");
        System.out.println("  --debug                 Enable Jakarta Mail debug logs");
        System.out.println();
        System.out.println("Modes:");
        System.out.println("  --check-only            Only test SMTP connect/login");
        System.out.println("  (without --check-only, a test mail is sent)");
        System.out.println();
        System.out.println("Mail options (send mode):");
        System.out.println("  --from <email>");
        System.out.println("  --to <email[,email2]>   Comma-separated recipients");
        System.out.println("  --subject <text>");
        System.out.println("  --body <text>");
        System.out.println("  --body-file <path>");
        System.out.println();
        System.out.println("Examples:");
        System.out.println("  Connection only:");
        System.out.println("    mvn -q exec:java -Dexec.mainClass=com.example.smtptest.SmtpTester -Dexec.args=\"--host smtp.example.com --port 587 --starttls --auth --username user --password secret --check-only\"");
        System.out.println();
        System.out.println("  Send test email:");
        System.out.println("    mvn -q exec:java -Dexec.mainClass=com.example.smtptest.SmtpTester -Dexec.args=\"--host smtp.example.com --port 587 --starttls --auth --username user --password secret --from me@example.com --to you@example.com --subject SMTP-Test --body Hello\"");
    }

    private static class CliOptions {
        private final Map<String, String> values = new HashMap<>();
        private final Set<String> flags;

        private CliOptions(Set<String> flags) {
            this.flags = flags;
        }

        static CliOptions parse(String[] args) {
            Set<String> localFlags = Arrays.stream(args)
                    .filter(a -> a.startsWith("--"))
                    .map(a -> a.substring(2))
                    .collect(Collectors.toSet());

            CliOptions options = new CliOptions(localFlags);

            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                if (!arg.startsWith("--")) {
                    continue;
                }

                String key = arg.substring(2);
                String next = (i + 1 < args.length) ? args[i + 1] : null;
                if (next != null && !next.startsWith("--")) {
                    options.values.put(key, next);
                    i++;
                }
            }

            return options;
        }

        String get(String key) {
            return values.get(key);
        }

        String getOrDefault(String key, String fallback) {
            return Objects.requireNonNullElse(values.get(key), fallback);
        }

        String require(String key) {
            String value = get(key);
            if (isBlank(value)) {
                throw new IllegalArgumentException("Missing required option: --" + key);
            }
            return value;
        }

        int getInt(String key, int fallback) {
            String value = values.get(key);
            if (value == null) {
                return fallback;
            }
            try {
                return Integer.parseInt(value);
            } catch (NumberFormatException ex) {
                throw new IllegalArgumentException("Invalid number for --" + key + ": " + value);
            }
        }

        boolean hasFlag(String key) {
            return flags.contains(key);
        }
    }
}
