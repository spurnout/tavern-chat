import type { JSX } from 'react';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Button, ErrorBanner, Field, Screen, StatusPill } from '@/components/ui';
import { useAuthStore } from '@/stores/auth-store';
import { colors, spacing, typography } from '@/theme/tokens';

const ANDROID_EMULATOR_URL = 'http://10.0.2.2:3001';

export function InstanceConnectScreen(): JSX.Element {
  const setInstanceUrl = useAuthStore((state) => state.setInstanceUrl);
  const error = useAuthStore((state) => state.error);
  const status = useAuthStore((state) => state.status);
  const [url, setUrl] = useState(ANDROID_EMULATOR_URL);

  async function connect(): Promise<void> {
    await setInstanceUrl(url);
  }

  const busy = status === 'checking';

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}
      >
        <View style={styles.hero}>
          <StatusPill label="Self-hosted Android client" tone="warn" />
          <Text style={styles.title}>Tavern</Text>
          <Text style={styles.copy}>
            Connect this phone to the Tavern instance your group already runs.
          </Text>
        </View>
        <View style={styles.form}>
          <Field
            label="Instance URL"
            value={url}
            onChangeText={setUrl}
            keyboardType="url"
            textContentType="URL"
            autoCapitalize="none"
            placeholder={ANDROID_EMULATOR_URL}
          />
          <ErrorBanner message={error} />
          <Button label="Connect" icon="log-in" onPress={() => void connect()} loading={busy} />
          <Button
            label="Use Android emulator URL"
            icon="smartphone"
            variant="ghost"
            onPress={() => setUrl(ANDROID_EMULATOR_URL)}
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
  hero: {
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
    fontSize: typography.bodyLarge,
    lineHeight: 24,
  },
  form: {
    gap: spacing.md,
  },
});
