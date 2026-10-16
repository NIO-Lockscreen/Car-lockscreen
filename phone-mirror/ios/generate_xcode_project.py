#!/usr/bin/env python3
"""Deterministic tiny Xcode .pbxproj generator; runs without Xcode dependencies."""
from pathlib import Path
import hashlib
BASE=Path(__file__).resolve().parent
proj=BASE/'BanyanMirror.xcodeproj';proj.mkdir(exist_ok=True)
entries={}
def uid(name):return hashlib.md5(('BanyanMJPEG-v02:'+name).encode()).hexdigest()[:24].upper()
def ref(name):return uid(name)
def obj(name, properties):entries[name]=properties
def q(s):
    if s.startswith('RAW:'):return s[4:]
    if s and all(c in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./$+-' for c in s):return s
    return '"'+s.replace('\\','\\\\').replace('"','\\"')+'"'
def val(v,indent=1):
    tab='\t'*indent
    if isinstance(v,str):return q(v)
    if isinstance(v,(list,tuple)):
        if not v:return '()'
        return '(\n'+''.join(tab+'\t'+val(x,indent+1)+',\n' for x in v)+tab+')'
    if isinstance(v,dict):
        if not v:return '{}'
        return '{\n'+''.join(tab+'\t'+q(str(k))+' = '+val(vv,indent+1)+';\n' for k,vv in v.items())+tab+'}'
    return str(v)
app_sources=['BanyanMirrorApp.swift','ContentView.swift','LocalNetworkPermission.swift','MirrorSettings.swift']
ext_sources=['SampleHandler.swift','ReceiverServer.swift','ReceiverHTML.swift','MirrorSettings.swift']
paths={
'BanyanMirrorApp.swift':'BanyanMirror/BanyanMirrorApp.swift',
'ContentView.swift':'BanyanMirror/ContentView.swift',
'LocalNetworkPermission.swift':'BanyanMirror/LocalNetworkPermission.swift',
'MirrorSettings.swift':'Shared/MirrorSettings.swift',
'SampleHandler.swift':'BroadcastUpload/SampleHandler.swift',
'ReceiverServer.swift':'BroadcastUpload/ReceiverServer.swift',
'ReceiverHTML.swift':'BroadcastUpload/ReceiverHTML.swift',
'AppInfo':'BanyanMirror/Info.plist',
'ExtInfo':'BroadcastUpload/Info.plist',
}
for name,path in paths.items():
    ext=Path(path).suffix
    obj('file:'+name,{'isa':'PBXFileReference','lastKnownFileType':{'swift':'sourcecode.swift','plist':'text.plist.xml','entitlements':'text.plist.entitlements'}.get(ext[1:],'text'), 'path':path,'sourceTree':'<group>'})
for target,srcs in [('App',app_sources),('Ext',ext_sources)]:
    for s in srcs:
        obj('build:'+target+':'+s,{'isa':'PBXBuildFile','fileRef':'RAW:'+ref('file:'+s)})
    obj('phase:source:'+target,{'isa':'PBXSourcesBuildPhase','buildActionMask':'RAW:2147483647','files':['RAW:'+ref('build:'+target+':'+s) for s in srcs],'runOnlyForDeploymentPostprocessing':'RAW:0'})
    obj('phase:frameworks:'+target,{'isa':'PBXFrameworksBuildPhase','buildActionMask':'RAW:2147483647','files':[],'runOnlyForDeploymentPostprocessing':'RAW:0'})
    obj('phase:resources:'+target,{'isa':'PBXResourcesBuildPhase','buildActionMask':'RAW:2147483647','files':[],'runOnlyForDeploymentPostprocessing':'RAW:0'})
obj('product:App',{'isa':'PBXFileReference','explicitFileType':'wrapper.application','includeInIndex':'RAW:0','path':'BanyanMirror.app','sourceTree':'BUILT_PRODUCTS_DIR'})
obj('product:Ext',{'isa':'PBXFileReference','explicitFileType':'wrapper.app-extension','includeInIndex':'RAW:0','path':'BroadcastUpload.appex','sourceTree':'BUILT_PRODUCTS_DIR'})
obj('build:embed',{'isa':'PBXBuildFile','fileRef':'RAW:'+ref('product:Ext'),'settings':{'ATTRIBUTES':['RemoveHeadersOnCopy','CodeSignOnCopy']}})
obj('phase:embed',{'isa':'PBXCopyFilesBuildPhase','buildActionMask':'RAW:2147483647','dstPath':'','dstSubfolderSpec':'RAW:13','files':['RAW:'+ref('build:embed')],'name':'Embed App Extensions','runOnlyForDeploymentPostprocessing':'RAW:0'})
obj('group:root',{'isa':'PBXGroup','children':['RAW:'+ref('group:app'),'RAW:'+ref('group:ext'),'RAW:'+ref('group:shared'),'RAW:'+ref('group:products')],'sourceTree':'<group>'})
obj('group:app',{'isa':'PBXGroup','children':['RAW:'+ref('file:'+x) for x in ['BanyanMirrorApp.swift','ContentView.swift','LocalNetworkPermission.swift','AppInfo']],'name':'BanyanMirror','sourceTree':'<group>'})
obj('group:ext',{'isa':'PBXGroup','children':['RAW:'+ref('file:'+x) for x in ['SampleHandler.swift','ReceiverServer.swift','ReceiverHTML.swift','ExtInfo']],'name':'BroadcastUpload','sourceTree':'<group>'})
obj('group:shared',{'isa':'PBXGroup','children':['RAW:'+ref('file:MirrorSettings.swift')],'name':'Shared','sourceTree':'<group>'})
obj('group:products',{'isa':'PBXGroup','children':['RAW:'+ref('product:App'),'RAW:'+ref('product:Ext')],'name':'Products','sourceTree':'<group>'})
obj('proxy:extension',{'isa':'PBXContainerItemProxy','containerPortal':'RAW:'+ref('project'),'proxyType':'RAW:1','remoteGlobalIDString':'RAW:'+ref('target:Ext'),'remoteInfo':'BroadcastUpload'})
obj('dependency:extension',{'isa':'PBXTargetDependency','target':'RAW:'+ref('target:Ext'),'targetProxy':'RAW:'+ref('proxy:extension')})
for target in ['App','Ext']:
    obj('target:'+target,{'isa':'PBXNativeTarget','buildConfigurationList':'RAW:'+ref('list:'+target),'buildPhases':['RAW:'+ref('phase:source:'+target),'RAW:'+ref('phase:frameworks:'+target),'RAW:'+ref('phase:resources:'+target)]+(['RAW:'+ref('phase:embed')] if target=='App' else []),'buildRules':[],'dependencies':['RAW:'+ref('dependency:extension')] if target=='App' else [],'name':'BanyanMirror' if target=='App' else 'BroadcastUpload','productName':'BanyanMirror' if target=='App' else 'BroadcastUpload','productReference':'RAW:'+ref('product:'+target),'productType':'com.apple.product-type.application' if target=='App' else 'com.apple.product-type.app-extension'})
for owner in ['Project','App','Ext']:
    for config in ['Debug','Release']:
        configSettings={'IPHONEOS_DEPLOYMENT_TARGET':'16.0','SDKROOT':'iphoneos','SWIFT_VERSION':'5.0','CLANG_ENABLE_MODULES':'YES'} if owner=='Project' else {
            'PRODUCT_NAME':'$(TARGET_NAME)','PRODUCT_BUNDLE_IDENTIFIER':'com.banyanmirror.ios' + ('.BroadcastUpload' if owner=='Ext' else ''),
            'GENERATE_INFOPLIST_FILE':'NO','INFOPLIST_FILE': ('BroadcastUpload/Info.plist' if owner=='Ext' else 'BanyanMirror/Info.plist'),
            'CODE_SIGN_STYLE':'Automatic','SWIFT_VERSION':'5.0','IPHONEOS_DEPLOYMENT_TARGET':'16.0',
            'TARGETED_DEVICE_FAMILY':'1','LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks']}
        if owner=='Ext':configSettings.update({'SKIP_INSTALL':'YES','APPLICATION_EXTENSION_API_ONLY':'YES'})
        if owner=='Project':configSettings.update({'ENABLE_BITCODE':'NO','SWIFT_OPTIMIZATION_LEVEL':'-Onone' if config=='Debug' else '-O','DEBUG_INFORMATION_FORMAT':'dwarf' if config=='Debug' else 'dwarf-with-dsym','GCC_OPTIMIZATION_LEVEL':'0' if config=='Debug' else 's'})
        obj('config:'+owner+':'+config,{'isa':'XCBuildConfiguration','buildSettings':configSettings,'name':config})
    obj('list:'+owner,{'isa':'XCConfigurationList','buildConfigurations':['RAW:'+ref('config:'+owner+':'+c) for c in ['Debug','Release']],'defaultConfigurationIsVisible':'RAW:0','defaultConfigurationName':'Release'})
obj('project',{'isa':'PBXProject','attributes':{'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'1600','TargetAttributes':{ref('target:App'):{'CreatedOnToolsVersion':'16.0'},ref('target:Ext'):{'CreatedOnToolsVersion':'16.0'}}},'buildConfigurationList':'RAW:'+ref('list:Project'),'compatibilityVersion':'Xcode 14.0','developmentRegion':'en','hasScannedForEncodings':'RAW:0','knownRegions':['en','Base'],'mainGroup':'RAW:'+ref('group:root'),'productRefGroup':'RAW:'+ref('group:products'),'projectDirPath':'','projectRoot':'','targets':['RAW:'+ref('target:App'),'RAW:'+ref('target:Ext')]})
order=['PBXBuildFile','PBXContainerItemProxy','PBXCopyFilesBuildPhase','PBXFileReference','PBXFrameworksBuildPhase','PBXGroup','PBXNativeTarget','PBXProject','PBXResourcesBuildPhase','PBXSourcesBuildPhase','PBXTargetDependency','XCBuildConfiguration','XCConfigurationList']
result='// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n'
for kind in order:
    result+='\n/* Begin '+kind+' section */\n'
    for name,props in sorted(entries.items()):
        if props.get('isa')==kind:
            result+='\t\t'+ref(name)+' /* '+name+' */ = '+val(props,2)+';\n'
    result+='/* End '+kind+' section */\n'
result+='\t};\n\trootObject = '+ref('project')+' /* Project object */;\n}\n'
(proj/'project.pbxproj').write_text(result)
scheme=proj/'xcshareddata/xcschemes/BanyanMirror.xcscheme';scheme.parent.mkdir(parents=True,exist_ok=True)
scheme.write_text('''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="%s" BuildableName="BanyanMirror.app" BlueprintName="BanyanMirror" ReferencedContainer="container:BanyanMirror.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.Posix" shouldUseLaunchSchemeArgsEnv="YES"/>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.Posix" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="%s" BuildableName="BanyanMirror.app" BlueprintName="BanyanMirror" ReferencedContainer="container:BanyanMirror.xcodeproj"/></BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"/>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''' %(ref('target:App'),ref('target:App')))
print('Generated:',proj)
