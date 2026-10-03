import { Component, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

// Menangkap error saat render dan menampilkannya, bukan force close.
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>Terjadi error</Text>
        <Text style={styles.hint}>Screenshot layar ini dan kirim ke developer.</Text>
        <Text selectable style={styles.msg}>
          {error.name}: {error.message}
        </Text>
        <Text selectable style={styles.stack}>
          {String(error.stack ?? '').slice(0, 1500)}
        </Text>
        <Pressable style={styles.btn} onPress={() => this.setState({ error: null })}>
          <Text style={styles.btnText}>Kembali ke aplikasi</Text>
        </Pressable>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingTop: 56, gap: 12, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '800', color: '#b91c1c' },
  hint: { color: '#6b7280' },
  msg: { fontSize: 15, fontWeight: '600' },
  stack: { fontSize: 11, color: '#374151', fontFamily: 'monospace' },
  btn: { backgroundColor: '#2563eb', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600' },
});
