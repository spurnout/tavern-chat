import type { JSX } from 'react';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Button, ErrorBanner, Field, Screen, StatusPill } from '@/components/ui';
import { useAuthStore } from '@/stores/auth-store';
import { colors, spacing, typography } from '@/theme/tokens';

export function BootstrapScreen(): JSX.Element {
  const bootstrapAdmin = useAuthStore((state) => state.bootstrapAdmin);
  const resetInstance = useAuthStore((state) => state.resetInstance);
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const [serverName, setServerName] = useState('The Tavern');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function submit(): Promise<void> {
    await bootstrapAdmin({ serverName, displayName, username, email, password });
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}
      >
        <View style={styles.header}>
          <StatusPill label="First run" tone="warn" />
          <Text style={styles.title}>Set up this Tavern</Text>
          <Text style={styles.copy}>
            This instance has no members yet. Create the first admin account from your phone.
          </Text>
        </View>
        <View style={styles.form}>
          <Field
            label="Tavern name"
            value={serverName}
            onChangeText={setServerName}
            placeholder="The Tavern"
            autoCapitalize="words"
          />
          <Field
            label="Display name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Rowan"
            autoCapitalize="words"
          />
          <Field label="Username" value={username} onChangeText={setUsername} placeholder="rowan" />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="rowan@example.com"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="newPassword"
            placeholder="Choose a password"
          />
          <ErrorBanner message={error} />
          <Button
            label="Create Tavern"
            icon="flag"
            onPress={() => void submit()}
            loading={status === 'checking'}
          />
          <Button
            label="Switch instance"
            icon="server"
            variant="ghost"
            onPress={() => void resetInstance()}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.xl,
  },
  header: {
    gap: spacing.md,
  },
  title: {
    color: colors.fg,
    fontSize: typography.display,
    fontWeight: '900',
    letterSpacing: 0,
  },
  copy: {
    color: colors.fgMuted,
    fontSize: typography.body,
    lineHeight: 22,
  },
  form: {
    gap: spacing.md,
  },
});
