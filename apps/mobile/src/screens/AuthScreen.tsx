import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button, ErrorBanner, Field, Screen, StatusPill } from '@/components/ui';
import { useAuthStore } from '@/stores/auth-store';
import { colors, spacing, typography } from '@/theme/tokens';

type AuthMode = 'login' | 'register';

export function AuthScreen(): JSX.Element {
  const modeInitial = useAuthStore((state) =>
    state.instanceInfo?.features.registrationOpen ? 'register' : 'login',
  );
  const [mode, setMode] = useState<AuthMode>(modeInitial);
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const instance = useAuthStore((state) => state.instanceInfo);
  const resetInstance = useAuthStore((state) => state.resetInstance);
  const login = useAuthStore((state) => state.login);
  const loginTotp = useAuthStore((state) => state.loginTotp);
  const register = useAuthStore((state) => state.register);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [totpCode, setTotpCode] = useState('');

  const busy = status === 'checking';
  const canRegister = Boolean(instance?.features.registrationOpen) || mode === 'register';
  const headline = useMemo(() => {
    if (status === 'totp-required') return 'Enter your code';
    return mode === 'login' ? 'Welcome back' : 'Pull up a chair';
  }, [mode, status]);

  async function submit(): Promise<void> {
    if (status === 'totp-required') {
      await loginTotp(totpCode);
      return;
    }
    if (mode === 'login') {
      await login({ identifier, password });
      return;
    }
    await register({ username, displayName, email, password, inviteCode });
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}
      >
        <View style={styles.header}>
          <StatusPill label={instance?.name ?? 'Tavern'} tone="info" />
          <Text style={styles.title}>{headline}</Text>
          <Text style={styles.copy}>
            {status === 'totp-required'
              ? 'This account has two-factor login enabled.'
              : 'Use the same account you use in the web Tavern.'}
          </Text>
        </View>
        <View style={styles.form}>
          {status === 'totp-required' ? (
            <Field
              label="Authentication code"
              value={totpCode}
              onChangeText={setTotpCode}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              placeholder="123456"
            />
          ) : mode === 'login' ? (
            <>
              <Field
                label="Username or email"
                value={identifier}
                onChangeText={setIdentifier}
                textContentType="username"
                placeholder="rowan"
              />
              <Field
                label="Password"
                value={password}
                onChangeText={setPassword}
                textContentType="password"
                secureTextEntry
                placeholder="Your password"
              />
            </>
          ) : (
            <>
              <Field
                label="Display name"
                value={displayName}
                onChangeText={setDisplayName}
                textContentType="name"
                placeholder="Rowan"
                autoCapitalize="words"
              />
              <Field
                label="Username"
                value={username}
                onChangeText={setUsername}
                textContentType="username"
                placeholder="rowan"
              />
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                textContentType="emailAddress"
                keyboardType="email-address"
                placeholder="rowan@example.com"
              />
              <Field
                label="Password"
                value={password}
                onChangeText={setPassword}
                textContentType="newPassword"
                secureTextEntry
                placeholder="Choose a password"
              />
              <Field
                label="Invite code"
                value={inviteCode}
                onChangeText={setInviteCode}
                autoCapitalize="characters"
                placeholder="DEV-INVITE"
              />
            </>
          )}
          <ErrorBanner message={error} />
          <Button
            label={status === 'totp-required' ? 'Verify code' : mode === 'login' ? 'Log in' : 'Register'}
            icon={status === 'totp-required' ? 'shield' : 'log-in'}
            onPress={() => void submit()}
            loading={busy}
          />
          {status !== 'totp-required' ? (
            <View style={styles.modeRow}>
              <Text style={styles.modeText}>
                {mode === 'login' ? 'Need an account?' : 'Already have an account?'}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setMode(mode === 'login' ? 'register' : 'login')}
                disabled={!canRegister && mode === 'login'}
              >
                <Text style={[styles.modeAction, !canRegister && styles.modeDisabled]}>
                  {mode === 'login' ? 'Register' : 'Log in'}
                </Text>
              </Pressable>
            </View>
          ) : null}
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
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  modeText: {
    color: colors.fgMuted,
    fontSize: typography.body,
  },
  modeAction: {
    color: colors.emberStrong,
    fontSize: typography.body,
    fontWeight: '800',
  },
  modeDisabled: {
    color: colors.fgSubtle,
  },
});
