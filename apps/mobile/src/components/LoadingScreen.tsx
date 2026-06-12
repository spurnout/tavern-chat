import type { JSX } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme/tokens';

export function LoadingScreen(): JSX.Element {
  return (
    <Screen>
      <View style={styles.center}>
        <ActivityIndicator color={colors.emberStrong} size="large" />
        <Text style={styles.text}>Pulling up a chair...</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  text: {
    color: colors.fgMuted,
    fontSize: typography.body,
  },
});
