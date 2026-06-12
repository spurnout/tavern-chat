import type { ComponentProps, JSX, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '@/theme/tokens';

type IconName = ComponentProps<typeof Feather>['name'];

interface ScreenProps {
  children: ReactNode;
  padded?: boolean;
}

export function Screen({ children, padded = true }: ScreenProps): JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.screenContent, padded ? styles.padded : null]}>{children}</View>
    </SafeAreaView>
  );
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName;
  style?: ViewStyle;
}

export function Button({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  icon,
  style,
}: ButtonProps): JSX.Element {
  const variantStyle = buttonVariantStyles[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variantStyle.container,
        (disabled || loading) && styles.buttonDisabled,
        pressed && !disabled && !loading ? styles.buttonPressed : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.sunken : colors.fg} />
      ) : icon ? (
        <Feather name={icon} size={18} color={variantStyle.text.color} />
      ) : null}
      <Text style={[styles.buttonLabel, variantStyle.text]}>{label}</Text>
    </Pressable>
  );
}

interface FieldProps extends TextInputProps {
  label: string;
  error?: string | null;
  keyboardType?: KeyboardTypeOptions;
}

export function Field({ label, error, style, ...props }: FieldProps): JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.fgSubtle}
        selectionColor={colors.emberStrong}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, style]}
        {...props}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

interface EmptyStateProps {
  title: string;
  body: string;
  icon?: IconName;
}

export function EmptyState({ title, body, icon = 'coffee' }: EmptyStateProps): JSX.Element {
  return (
    <View style={styles.empty}>
      <Feather name={icon} size={26} color={colors.emberStrong} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

interface StatusPillProps {
  label: string;
  tone?: 'neutral' | 'good' | 'warn' | 'info';
}

export function StatusPill({ label, tone = 'neutral' }: StatusPillProps): JSX.Element {
  return (
    <View style={[styles.pill, pillToneStyles[tone]]}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

export function ErrorBanner({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return (
    <View style={styles.errorBanner}>
      <Feather name="alert-triangle" size={16} color={colors.danger} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const buttonVariantStyles = {
  primary: StyleSheet.create({
    container: { backgroundColor: colors.ember, borderColor: colors.ember },
    text: { color: colors.sunken },
  }),
  secondary: StyleSheet.create({
    container: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
    text: { color: colors.fg },
  }),
  ghost: StyleSheet.create({
    container: { backgroundColor: 'transparent', borderColor: colors.border },
    text: { color: colors.fg },
  }),
  danger: StyleSheet.create({
    container: { backgroundColor: '#3b1d1d', borderColor: colors.danger },
    text: { color: colors.fg },
  }),
};

const pillToneStyles = StyleSheet.create({
  neutral: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  good: { backgroundColor: '#1f3526', borderColor: colors.moss },
  warn: { backgroundColor: colors.tintEmber, borderColor: colors.ember },
  info: { backgroundColor: '#1d2a3f', borderColor: colors.info },
});

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  screenContent: {
    flex: 1,
  },
  padded: {
    padding: spacing.lg,
  },
  button: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  buttonLabel: {
    fontSize: typography.body,
    fontWeight: '700',
    letterSpacing: 0,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonPressed: {
    opacity: 0.82,
  },
  field: {
    gap: spacing.xs,
  },
  fieldLabel: {
    color: colors.fgMuted,
    fontSize: typography.caption,
    fontWeight: '700',
    letterSpacing: 0,
  },
  input: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.sunken,
    color: colors.fg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.body,
  },
  fieldError: {
    color: colors.danger,
    fontSize: typography.caption,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  emptyTitle: {
    color: colors.fg,
    fontSize: typography.bodyLarge,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyBody: {
    color: colors.fgMuted,
    fontSize: typography.body,
    lineHeight: 21,
    textAlign: 'center',
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pillText: {
    color: colors.fg,
    fontSize: typography.tiny,
    fontWeight: '700',
    letterSpacing: 0,
  },
  errorBanner: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
    backgroundColor: '#321b1b',
    padding: spacing.md,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  errorText: {
    color: colors.fg,
    flex: 1,
    fontSize: typography.caption,
    lineHeight: 18,
  },
});
