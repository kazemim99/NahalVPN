package ir.nahalkmi.nahalvpn.ui

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ir.nahalkmi.nahalvpn.NahalApp
import ir.nahalkmi.nahalvpn.R

class MainActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: android.content.Context) = super.attachBaseContext(ir.nahalkmi.nahalvpn.AppLocale.wrap(newBase))

    private val vm: AppViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel((application as NahalApp).graph) as T
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        // Outage notice: checked whenever the app comes to the front, then every minute while it stays there.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                vm.noticeOnOpen()
                while (true) { vm.checkNotice(); delay(60_000) }
            }
        }
        setContent {
            NahalTheme {
                val notice by vm.notice.collectAsStateWithLifecycle()
                notice?.let { NoticeDialog(it.message.orEmpty(), vm::closeNotice) }
                val signedIn by vm.signedIn.collectAsStateWithLifecycle()
                if (!signedIn) {
                    val login by vm.login.collectAsStateWithLifecycle()
                    LoginScreen(login, vm::signIn)
                } else {
                    Main()
                }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun Main() {
        var tab by rememberSaveable { mutableIntStateOf(0) }
        val vpnPermission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == RESULT_OK) vm.connect()
            else Toast.makeText(this, R.string.vpn_permission_denied, Toast.LENGTH_LONG).show()
        }
        val connect = {
            val prepare = VpnService.prepare(this)
            if (prepare == null) vm.connect() else vpnPermission.launch(prepare)
        }
        Scaffold(
            bottomBar = {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                    listOf(R.string.app_name to Icons.Filled.Home, R.string.account to Icons.Filled.Person,
                        R.string.settings to Icons.Filled.Settings).forEachIndexed { i, (label, icon) ->
                        NavigationBarItem(selected = tab == i, onClick = { tab = i },
                            icon = { Icon(icon, contentDescription = null) },
                            label = { Text(stringResource(label)) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary,
                                selectedTextColor = MaterialTheme.colorScheme.primary,
                                indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                            ))
                    }
                }
            },
        ) { pad ->
            Box(Modifier.fillMaxSize().padding(pad)) {
                when (tab) {
                    0 -> {
                        val state by vm.vpn.collectAsStateWithLifecycle()
                        val locations by vm.locations.collectAsStateWithLifecycle()
                        val selected by vm.selected.collectAsStateWithLifecycle()
                        val netErr by vm.networkError.collectAsStateWithLifecycle()
                        val update by vm.update.collectAsStateWithLifecycle()
                        val me by vm.me.collectAsStateWithLifecycle()
                        val kill by vm.killSwitch.collectAsStateWithLifecycle()
                        val ping by vm.ping.collectAsStateWithLifecycle()
                        val speed by vm.speed.collectAsStateWithLifecycle()
                        val protocol by vm.protocol.collectAsStateWithLifecycle()
                        HomeScreen(
                            HomeUi(state, locations, selected, netErr, update, me?.expiresAt, kill, ping, speed, protocol),
                            HomeActions(connect, vm::disconnect, vm::select, vm::refresh, vm::installUpdate, vm::setKillSwitch, vm::ping, vm::speedTest, vm::setProtocol),
                        )
                    }
                    1 -> {
                        val me by vm.me.collectAsStateWithLifecycle()
                        AccountScreen(me, vm::removeDevice, vm::signOut, vm::changePassword)
                    }
                    else -> {
                        val ks by vm.killSwitch.collectAsStateWithLifecycle()
                        SettingsScreen(ks, vm::setKillSwitch, onOpenVpnSettings = {
                            startActivity(Intent(if (Build.VERSION.SDK_INT >= 24) Settings.ACTION_VPN_SETTINGS else Settings.ACTION_WIRELESS_SETTINGS))
                        }, language = ir.nahalkmi.nahalvpn.AppLocale.get(this@MainActivity), onLanguage = { ir.nahalkmi.nahalvpn.AppLocale.set(this@MainActivity, it); recreate() })
                    }
                }
            }
        }
    }
}
