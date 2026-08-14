package com.dshmobile.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * CredentialStore —— 用 Android Keystore（系统安全硬件 TEE）保护的 AES-GCM 加密存储。
 * 密钥生成后锁在安全硬件内，应用只能拿到密文；明文仅存在于进程内存。
 * 存储格式：enc: + Base64(IV(12) + ciphertext)。
 * 解密失败（密钥被清/数据损坏）返回空串，调用方按"未设置"处理，应用不崩溃。
 * minSdk 26：KeyGenParameterSpec / AES-GCM 全部可用。
 */
public final class CredentialStore {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "dsh_cred_key";
    private static final String PREFIX = "enc:";
    private static final int IV_LEN = 12;   // GCM 标准 IV
    private static final int GCM_TAG_BITS = 128;

    private CredentialStore() {
    }

    /** 该存储串是否为加密格式（非加密 = 旧版明文或空）。 */
    public static boolean isEncrypted(String stored) {
        return stored != null && stored.startsWith(PREFIX);
    }

    /** 加密并返回存储串；失败（Keystore 异常）返回 null，调用方不得回退存明文。 */
    public static String encrypt(String plain) {
        if (plain == null || plain.isEmpty()) return plain;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /** 解密存储串；旧版明文原样返回（迁移路径）；密钥失效/格式错误返回空串。 */
    public static String decrypt(String stored) {
        if (stored == null || stored.isEmpty()) return stored;
        if (!stored.startsWith(PREFIX)) return stored; // 旧版明文：未加密，直接返回
        try {
            byte[] all = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
            if (all.length < IV_LEN + GCM_TAG_BITS / 8) return "";
            byte[] iv = new byte[IV_LEN];
            System.arraycopy(all, 0, iv, 0, IV_LEN);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] pt = c.doFinal(all, IV_LEN, all.length - IV_LEN);
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    /** 取密钥；不存在则生成（首次调用）。 */
    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return kg.generateKey();
    }
}
